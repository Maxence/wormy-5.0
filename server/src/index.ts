import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin';
app.use('/admin', (req, res, next) => {
  const token = req.header('authorization')?.replace('Bearer ', '');
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/admin/stats', (_req, res) => {
  // Filled later once roomManager is defined
  res.json({ rooms: [], totals: { players: 0, rooms: 0 } });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const wssAdmin = new WebSocketServer({ server, path: '/admin-ws' });

// --- Core types ---
type Vector2 = { x: number; y: number };
type Player = {
  id: string;
  name: string;
  score: number;
  position: Vector2;
  directionRad: number;
  boosting: boolean;
  ws: WebSocket;
};

type RoomConfig = {
  mapSize: number; // world is [-mapSize, mapSize]^2
  maxPlayers: number;
  foodCoveragePercent: number; // percentage of map area covered by food mass
  foodSpawnRatePerSecond: number; // target rate
};

type GameRoom = {
  id: string;
  config: RoomConfig;
  players: Map<string, Player>;
  spectators: Set<WebSocket>;
  isClosed: boolean;
};

type ClientMeta = {
  id: string;
  roomId: string | null;
  lastPingId: number | null;
  lastPingSentAt: number | null;
  rttMs: number | null;
};

type AdminSpectatorMeta = {
  subscribedRoomId: string | null;
};

// --- Managers ---
class RoomManager {
  private rooms: Map<string, GameRoom> = new Map();

  constructor(private defaultConfig: RoomConfig) {}

  listRooms() {
    return Array.from(this.rooms.values());
  }

  getRoom(id: string) {
    return this.rooms.get(id) || null;
  }

  createRoom(config?: Partial<RoomConfig>): GameRoom {
    const id = uuidv4();
    const room: GameRoom = {
      id,
      config: { ...this.defaultConfig, ...config },
      players: new Map(),
      spectators: new Set(),
      isClosed: false,
    };
    this.rooms.set(id, room);
    return room;
  }

  closeRoom(id: string): boolean {
    const room = this.rooms.get(id);
    if (!room) return false;
    room.isClosed = true;
    // disconnect players
    for (const p of room.players.values()) {
      try { p.ws.close(1000, 'room closed'); } catch {}
    }
    room.players.clear();
    // notify spectators
    for (const s of room.spectators) {
      try { s.send(JSON.stringify({ t: 'room_closed', roomId: id })); } catch {}
      try { s.close(1000, 'room closed'); } catch {}
    }
    room.spectators.clear();
    this.rooms.delete(id);
    return true;
  }

  findRoomWithSlot(): GameRoom {
    for (const room of this.rooms.values()) {
      if (!room.isClosed && room.players.size < room.config.maxPlayers) return room;
    }
    return this.createRoom();
  }
}

const DEFAULT_ROOM_CONFIG: RoomConfig = {
  mapSize: 5000,
  maxPlayers: 100,
  foodCoveragePercent: 2,
  foodSpawnRatePerSecond: 200,
};

const roomManager = new RoomManager(DEFAULT_ROOM_CONFIG);
const wsToMeta = new WeakMap<WebSocket, ClientMeta>();
const adminWsToMeta = new WeakMap<WebSocket, AdminSpectatorMeta>();
const bannedNames = new Set<string>();

wss.on('connection', (ws: WebSocket) => {
  wsToMeta.set(ws, {
    id: uuidv4(),
    roomId: null,
    lastPingId: null,
    lastPingSentAt: null,
    rttMs: null,
  });
  ws.send(JSON.stringify({ t: 'welcome' }));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data));
      // Join flow
      if (msg?.t === 'hello') {
        const rawName = typeof msg.name === 'string' ? msg.name : '';
        const name = rawName.trim().slice(0, 20);
        if (!name) { ws.send(JSON.stringify({ t: 'error', error: 'INVALID_NAME' })); return; }
        if (bannedNames.has(name.toLowerCase())) { ws.send(JSON.stringify({ t: 'error', error: 'BANNED' })); return; }
        const meta = wsToMeta.get(ws)!;
        if (meta.roomId) return;
        const room = roomManager.findRoomWithSlot();
        const playerId = uuidv4();
        const player: Player = {
          id: playerId,
          name,
          score: 10,
          position: { x: 0, y: 0 },
          directionRad: 0,
          boosting: false,
          ws,
        };
        room.players.set(playerId, player);
        meta.roomId = room.id;
        ws.send(JSON.stringify({ t: 'joined', roomId: room.id, playerId }));
        return;
      }

      // Player input (to be validated in simulation tick)
      if (msg?.t === 'input') {
        const meta = wsToMeta.get(ws);
        if (!meta?.roomId) return;
        const room = roomManager.getRoom(meta.roomId);
        if (!room) return;
        const player = room.players.get(msg.playerId);
        if (!player) return;
        if (typeof msg.directionRad === 'number') player.directionRad = msg.directionRad;
        if (typeof msg.boosting === 'boolean') player.boosting = msg.boosting;
        return;
      }

      // Echo-based latency: client replies with pong for server pings
      if (msg?.t === 'pong' && typeof msg.pingId === 'number') {
        const meta = wsToMeta.get(ws);
        if (meta && meta.lastPingId === msg.pingId && typeof meta.lastPingSentAt === 'number') {
          meta.rttMs = Date.now() - meta.lastPingSentAt;
          ws.send(JSON.stringify({ t: 'latency', rttMs: meta.rttMs }));
        }
        return;
      }
      // Optional: client initiated ping
      if (msg?.t === 'ping') {
        ws.send(JSON.stringify({ t: 'pong', now: Date.now(), pingId: msg.pingId ?? null }));
        return;
      }
    } catch {
    }
  });
  ws.on('close', () => {
    const meta = wsToMeta.get(ws);
    if (meta?.roomId) {
      const room = roomManager.getRoom(meta.roomId);
      if (room) {
        for (const [pid, p] of room.players) {
          if (p.ws === ws) room.players.delete(pid);
        }
      }
    }
    wsToMeta.delete(ws);
  });
});

// Server-initiated ping loop
setInterval(() => {
  const now = Date.now();
  const pingId = now; // simple unique id
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      const meta = wsToMeta.get(client);
      if (!meta) return;
      meta.lastPingId = pingId;
      meta.lastPingSentAt = now;
      client.send(JSON.stringify({ t: 'ping', pingId }));
    }
  });
}, 2000);

// --- Admin WS (spectator) ---
wssAdmin.on('connection', (ws: WebSocket, req) => {
  const token = req.headers['authorization']?.toString().replace('Bearer ', '') || '';
  if (token !== ADMIN_TOKEN) {
    try { ws.close(1008, 'unauthorized'); } catch {}
    return;
  }
  adminWsToMeta.set(ws, { subscribedRoomId: null });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data));
      if (msg?.t === 'subscribe' && typeof msg.roomId === 'string') {
        adminWsToMeta.set(ws, { subscribedRoomId: msg.roomId });
        ws.send(JSON.stringify({ t: 'subscribed', roomId: msg.roomId }));
        return;
      }
    } catch {}
  });
  ws.on('close', () => {
    adminWsToMeta.delete(ws);
  });
});

// periodic snapshots to spectators
setInterval(() => {
  // Iterate connected admin sockets
  (wssAdmin.clients as Set<WebSocket>).forEach((clientWs) => {
    const meta = adminWsToMeta.get(clientWs);
    if (!meta || clientWs.readyState !== clientWs.OPEN || !meta.subscribedRoomId) return;
    const room = roomManager.getRoom(meta.subscribedRoomId);
    if (!room) return;
    const players = Array.from(room.players.values()).map((p) => ({ id: p.id, name: p.name, score: p.score, position: p.position }));
    try { clientWs.send(JSON.stringify({ t: 'snapshot', roomId: room.id, players })); } catch {}
  });
}, 1000);

// --- Admin HTTP endpoints ---
app.get('/admin/rooms', (_req, res) => {
  const rooms = roomManager.listRooms().map((r) => ({ id: r.id, players: r.players.size, maxPlayers: r.config.maxPlayers, isClosed: r.isClosed }));
  res.json({ rooms });
});

app.post('/admin/rooms', (req, res) => {
  const cfg = req.body?.config || {};
  const room = roomManager.createRoom(cfg);
  res.json({ roomId: room.id });
});

app.delete('/admin/rooms/:id', (req, res) => {
  const ok = roomManager.closeRoom(req.params.id);
  if (!ok) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ ok: true });
});

app.get('/admin/rooms/:id/players', (req, res) => {
  const room = roomManager.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'NOT_FOUND' });
  const players = Array.from(room.players.values()).map((p) => ({ id: p.id, name: p.name, score: p.score }));
  res.json({ players });
});

app.post('/admin/rooms/:id/kick', (req, res) => {
  const playerId = req.body?.playerId;
  if (!playerId || typeof playerId !== 'string') return res.status(400).json({ error: 'INVALID_PLAYER_ID' });
  const room = roomManager.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'NOT_FOUND' });
  const player = room.players.get(playerId);
  if (!player) return res.status(404).json({ error: 'PLAYER_NOT_FOUND' });
  try { player.ws.close(4000, 'kicked'); } catch {}
  room.players.delete(playerId);
  res.json({ ok: true });
});

app.post('/admin/ban', (req, res) => {
  const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
  const name = rawName.trim();
  if (!name) return res.status(400).json({ error: 'INVALID_NAME' });
  bannedNames.add(name.toLowerCase());
  // disconnect any matching players
  for (const room of roomManager.listRooms()) {
    for (const [id, p] of room.players) {
      if (p.name.toLowerCase() === name.toLowerCase()) {
        try { p.ws.close(4001, 'banned'); } catch {}
        room.players.delete(id);
      }
    }
  }
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, () => console.log(`server listening on http://localhost:${PORT}`));
