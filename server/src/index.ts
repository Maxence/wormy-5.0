import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

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
  const rooms = roomManager.listRooms().map((r) => {
    const samples = r.tickDurationsMs.slice(-100).sort((a,b)=>a-b)
    const p95 = samples.length ? samples[Math.floor(samples.length*0.95)] : 0
    const broadcastHz = r.lastBroadcastAt ? Math.min(5, 1000 / Math.max(1, Date.now() - r.lastBroadcastAt)) : 0
    return { id: r.id, players: r.players.size, maxPlayers: r.config.maxPlayers, isClosed: r.isClosed, p95TickMs: Number(p95.toFixed(2)), broadcastHz: Number(broadcastHz.toFixed(2)) };
  });
  const totals = { players: rooms.reduce((a, r) => a + r.players, 0), rooms: rooms.length, memMB: Math.round(process.memoryUsage().heapUsed/1e6) };
  res.json({ rooms, totals, uptimeSec: Math.round(process.uptime()) });
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
  targetDirectionRad: number;
  boosting: boolean;
  ws: WebSocket;
  bodyPoints: Vector2[];
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
  foods: Food[];
  tickDurationsMs: number[]; // ring buffer
  lastBroadcastAt: number;
};

type Food = { id: string; position: Vector2; value: number };

type ClientMeta = {
  id: string;
  roomId: string | null;
  lastPingId: number | null;
  lastPingSentAt: number | null;
  rttMs: number | null;
  lastPongAt: number | null;
  lastInputAt: number | null;
  lastMessageAt: number | null;
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
      foods: [],
      tickDurationsMs: [],
      lastBroadcastAt: 0,
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

let DEFAULT_ROOM_CONFIG: RoomConfig = {
  mapSize: 5000,
  maxPlayers: 100,
  foodCoveragePercent: 2,
  foodSpawnRatePerSecond: 200,
};

const roomManager = new RoomManager(DEFAULT_ROOM_CONFIG);
const wsToMeta = new WeakMap<WebSocket, ClientMeta>();
const adminWsToMeta = new WeakMap<WebSocket, AdminSpectatorMeta>();
const bannedNames = new Set<string>();

// --- Helpers ---
function distanceSquared(a: Vector2, b: Vector2): number {
  const dx = a.x - b.x; const dy = a.y - b.y; return dx*dx + dy*dy;
}

function computeRadius(score: number): number {
  return 6 + Math.sqrt(Math.max(0, score)) * 0.6;
}

function computeTargetLength(score: number): number {
  return 120 + score * 2.5;
}

function computeSpeed(score: number, boosting: boolean): number {
  const base = 220 / (1 + 0.004 * Math.max(0, score));
  return boosting ? base * 1.55 : base;
}

function trimBodyToLength(points: Vector2[], targetLength: number): void {
  if (points.length <= 1) return;
  let total = 0;
  for (let i = points.length - 1; i > 0; i--) {
    const seg = Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y);
    total += seg;
    if (total > targetLength) {
      points.splice(0, i - 1);
      return;
    }
  }
}

function jitter(n: number): number { return (Math.random() - 0.5) * n; }

function normalizeAngle(angle: number): number {
  let a = angle;
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

function rotateTowards(current: number, target: number, maxDelta: number): number {
  const diff = normalizeAngle(target - current);
  const clamped = Math.max(-maxDelta, Math.min(maxDelta, diff));
  return normalizeAngle(current + clamped);
}

wss.on('connection', (ws: WebSocket) => {
  wsToMeta.set(ws, {
    id: uuidv4(),
    roomId: null,
    lastPingId: null,
    lastPingSentAt: null,
    rttMs: null,
    lastPongAt: null,
    lastInputAt: null,
    lastMessageAt: Date.now(),
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
          targetDirectionRad: 0,
          boosting: false,
          ws,
          bodyPoints: [{ x: 0, y: 0 }],
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
        meta.lastInputAt = Date.now();
        const room = roomManager.getRoom(meta.roomId);
        if (!room) return;
        const player = room.players.get(msg.playerId);
        if (!player) return;
        if (typeof msg.directionRad === 'number') player.targetDirectionRad = msg.directionRad;
        if (typeof msg.boosting === 'boolean') player.boosting = msg.boosting;
        return;
      }

      // Echo-based latency: client replies with pong for server pings
      if (msg?.t === 'pong' && typeof msg.pingId === 'number') {
        const meta = wsToMeta.get(ws);
        if (meta && meta.lastPingId === msg.pingId && typeof meta.lastPingSentAt === 'number') {
          meta.rttMs = Date.now() - meta.lastPingSentAt;
          meta.lastPongAt = Date.now();
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
    const meta = wsToMeta.get(ws);
    if (meta) meta.lastMessageAt = Date.now();
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

// Disconnect inactive or unresponsive clients
setInterval(() => {
  const now = Date.now();
  (wss.clients as Set<WebSocket>).forEach((client) => {
    const meta = wsToMeta.get(client);
    if (!meta) return;
    const noPongFor = meta.lastPingSentAt ? now - (meta.lastPongAt ?? 0) : 0;
    const idleFor = now - (meta.lastMessageAt ?? 0);
    if (noPongFor > 15000 || idleFor > 600000) { // 15s no pong or 10 min idle
      try { client.close(4002, 'inactive'); } catch {}
      wsToMeta.delete(client);
    }
  });
}, 5000);

// --- Simulation loop per room ---
const TICK_RATE = 20; // 20 Hz
const BROADCAST_RATE = 5; // 5 Hz snapshots to players
setInterval(() => {
  const dt = 1 / TICK_RATE;
  for (const room of roomManager.listRooms()) {
    if (room.isClosed) continue;
    const t0 = (globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now();
    // Move players (bounded turn rate)
    for (const player of room.players.values()) {
      // limit rotation to ~2 rad/s
      const maxTurn = 2 * dt;
      player.directionRad = rotateTowards(player.directionRad, player.targetDirectionRad, maxTurn);
      const speed = computeSpeed(player.score, player.boosting);
      const dx = Math.cos(player.directionRad) * speed * dt;
      const dy = Math.sin(player.directionRad) * speed * dt;
      player.position.x = Math.max(-room.config.mapSize, Math.min(room.config.mapSize, player.position.x + dx));
      player.position.y = Math.max(-room.config.mapSize, Math.min(room.config.mapSize, player.position.y + dy));
      player.bodyPoints.push({ x: player.position.x, y: player.position.y });
      trimBodyToLength(player.bodyPoints, computeTargetLength(player.score));
      if (player.boosting && player.score > 1) {
        player.score -= Math.max(0.1, Math.min(1.5, player.score * 0.002));
        if (Math.random() < 0.3) {
          room.foods.push({ id: uuidv4(), position: { x: player.position.x + jitter(8), y: player.position.y + jitter(8) }, value: 0.5 });
        }
      }
    }

    // Food consumption
    const toKeep: Food[] = [];
    for (const food of room.foods) {
      let eaten = false;
      for (const player of room.players.values()) {
        const r = computeRadius(player.score);
        if (distanceSquared(player.position, food.position) <= (r*r)) {
          player.score += food.value;
          eaten = true; break;
        }
      }
      if (!eaten) toKeep.push(food);
    }
    room.foods = toKeep;

    // Collisions detection
    const deaths: string[] = [];
    const playersArr = Array.from(room.players.values());
    // helper: distance squared between point and segment
    const distPointSeg2 = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
      const abx = bx - ax; const aby = by - ay;
      const apx = px - ax; const apy = py - ay;
      const ab2 = abx*abx + aby*aby;
      const t = ab2 > 0 ? Math.max(0, Math.min(1, (apx*abx + apy*aby) / ab2)) : 0;
      const qx = ax + t * abx; const qy = ay + t * aby;
      const dx = px - qx; const dy = py - qy; return dx*dx + dy*dy;
    };
    for (let i = 0; i < playersArr.length; i++) {
      const a = playersArr[i];
      const aR = computeRadius(a.score);
      // self collision against segments (skip last 12 points near head)
      for (let k = 0; k < a.bodyPoints.length - 12; k++) {
        const p1 = a.bodyPoints[k];
        const p2 = a.bodyPoints[Math.min(k+1, a.bodyPoints.length - 13)];
        const d2 = distPointSeg2(a.position.x, a.position.y, p1.x, p1.y, p2.x, p2.y);
        if (d2 < (aR * aR) * 0.7) { deaths.push(a.id); break; }
      }
      if (deaths.includes(a.id)) continue;
      for (let j = 0; j < playersArr.length; j++) {
        if (i === j) continue;
        const b = playersArr[j];
        const bR = computeRadius(b.score);
        // head vs body segments of b, skip last 12 points near b's head
        for (let k = 0; k < b.bodyPoints.length - 12; k++) {
          const p1 = b.bodyPoints[k];
          const p2 = b.bodyPoints[Math.min(k+1, b.bodyPoints.length - 13)];
          const d2 = distPointSeg2(a.position.x, a.position.y, p1.x, p1.y, p2.x, p2.y);
          const bodyThickness = Math.max(3, bR * 0.6);
          if (d2 < (aR + bodyThickness) * (aR + bodyThickness)) { deaths.push(a.id); break; }
        }
        if (deaths.includes(a.id)) break;
        // head-to-head
        const hh2 = distanceSquared(a.position, b.position);
        const thresh = (aR + bR) * (aR + bR) * 0.5;
        if (hh2 < thresh) {
          if (a.score < b.score) deaths.push(a.id);
          else if (b.score < a.score) deaths.push(b.id);
          else deaths.push(a.id); // tie-break
        }
      }
    }

    if (deaths.length) {
      const unique = Array.from(new Set(deaths));
      for (const id of unique) {
        const p = room.players.get(id);
        if (!p) continue;
        for (let t = 0; t < p.bodyPoints.length; t += 4) {
          const base = p.bodyPoints[t];
          const val = Math.max(0.5, p.score / Math.max(10, p.bodyPoints.length));
          room.foods.push({ id: uuidv4(), position: { x: base.x + jitter(12), y: base.y + jitter(12) }, value: val });
        }
        try { p.ws.send(JSON.stringify({ t: 'dead' })); } catch {}
        room.players.delete(id);
      }
    }

    // Spawn food clusters to maintain density
    const desiredFoodCount = Math.floor((room.config.foodCoveragePercent / 100) * 3000);
    if (room.foods.length < desiredFoodCount) {
      const center: Vector2 = { x: (Math.random() * 2 - 1) * room.config.mapSize, y: (Math.random() * 2 - 1) * room.config.mapSize };
      const clusterSize = 20 + Math.floor(Math.random() * 60);
      for (let n = 0; n < clusterSize; n++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * 120 + 20;
        const pos = { x: center.x + Math.cos(angle) * radius + jitter(8), y: center.y + Math.sin(angle) * radius + jitter(8) };
        room.foods.push({ id: uuidv4(), position: pos, value: 1 + Math.random() * 3 });
      }
    }
    const t1 = (globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now();
    const dur = t1 - t0;
    room.tickDurationsMs.push(dur);
    if (room.tickDurationsMs.length > 200) room.tickDurationsMs.shift();
  }
}, 1000 / TICK_RATE);

// Broadcast snapshots to players
setInterval(() => {
  for (const room of roomManager.listRooms()) {
    if (room.isClosed) continue;
    const lb = Array.from(room.players.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((p) => ({ id: p.id, name: p.name, score: Math.round(p.score) }));
    const foods = room.foods.slice(0, 500);
    const players = Array.from(room.players.values()).map((p) => ({ id: p.id, name: p.name, score: Math.round(p.score), position: p.position }));
    const payload = JSON.stringify({ t: 'state', roomId: room.id, leaderboard: lb, players, foods, mapSize: room.config.mapSize, serverNow: Date.now() });
    for (const p of room.players.values()) {
      if (p.ws.readyState === p.ws.OPEN) {
        try { p.ws.send(payload); } catch {}
      }
    }
    room.lastBroadcastAt = Date.now();
  }
}, 1000 / BROADCAST_RATE);

// --- Admin WS (spectator) ---
wssAdmin.on('connection', (ws: WebSocket, req) => {
  let token = req.headers['authorization']?.toString().replace('Bearer ', '') || '';
  try {
    // Fallback to query param for browsers
    const urlStr = req.url || '';
    const parsed = new URL(urlStr, 'http://localhost');
    if (!token) token = parsed.searchParams.get('token') || '';
  } catch {}
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

const RoomConfigSchema = z.object({
  mapSize: z.number().min(1000).max(20000).optional(),
  maxPlayers: z.number().min(2).max(500).optional(),
  foodCoveragePercent: z.number().min(0).max(50).optional(),
  foodSpawnRatePerSecond: z.number().min(0).max(10000).optional(),
});

app.get('/admin/rooms/:id/config', (req, res) => {
  const room = roomManager.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ config: room.config });
});

app.patch('/admin/rooms/:id/config', (req, res) => {
  const room = roomManager.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'NOT_FOUND' });
  const parse = RoomConfigSchema.safeParse(req.body || {});
  if (!parse.success) return res.status(400).json({ error: 'INVALID_CONFIG', details: parse.error.issues });
  room.config = { ...room.config, ...parse.data };
  res.json({ config: room.config });
});

// Default config endpoints
app.get('/admin/config/default', (_req, res) => {
  res.json({ config: DEFAULT_ROOM_CONFIG });
});

app.patch('/admin/config/default', (req, res) => {
  const parse = RoomConfigSchema.safeParse(req.body || {});
  if (!parse.success) return res.status(400).json({ error: 'INVALID_CONFIG', details: parse.error.issues });
  DEFAULT_ROOM_CONFIG = { ...DEFAULT_ROOM_CONFIG, ...parse.data };
  res.json({ config: DEFAULT_ROOM_CONFIG });
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

app.get('/admin/players', (_req, res) => {
  const rooms = roomManager.listRooms();
  const players = rooms.flatMap((r) => Array.from(r.players.values()).map((p) => ({ id: p.id, name: p.name, score: p.score, roomId: r.id })));
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
