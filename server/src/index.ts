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

const ADMIN_TOKEN_ENV = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN_ENV) {
  console.error('ADMIN_TOKEN environment variable is required to start the server.');
  process.exit(1);
}
const ADMIN_TOKEN = ADMIN_TOKEN_ENV;
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
  const totals = {
    players: rooms.reduce((a, r) => a + r.players, 0),
    rooms: rooms.length,
    memMB: Math.round(process.memoryUsage().heapUsed / 1e6),
    metrics: {
      inputSpoofRejected: metrics.inputSpoofRejected,
      inputInvalid: metrics.inputInvalid,
      inputThrottled: metrics.inputThrottled,
      roomsClosedTimeout: metrics.roomsClosedTimeout,
    },
  };
  res.json({ rooms, totals, uptimeSec: Math.round(process.uptime()) });
});

const server = http.createServer(app);
// Route upgrades manually for robustness
const wss = new WebSocketServer({ noServer: true });
const wssAdmin = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  try {
    const urlStr = req.url || '/';
    const u = new URL(urlStr, 'http://localhost');
    if (u.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else if (u.pathname === '/admin-ws') {
      wssAdmin.handleUpgrade(req, socket, head, (ws) => {
        wssAdmin.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
});

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
  emptyRoomTtlSeconds: number; // auto-close timer when no players
  suctionRadiusMultiplier: number; // 0 disables suction, >1 extends reach
  suctionStrengthMultiplier: number; // scales pull speed towards player
  foodValueMultiplier: number; // scales the score gained from food
  foodNearPlayerTarget: number; // desired count of food near each player
  bodyRadiusMultiplier: number; // scales player visual radius
  bodyLengthMultiplier: number; // scales player body length
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
  emptySince: number | null;
  minimapSnapshot: { players: { id: string; name: string; score: number; position: { x: number; y: number } }[]; foods: { x: number; y: number; value: number; count: number }[] } | null;
  minimapSnapshotAt: number;
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
  inputAllowance: number;
  inputRefillAt: number;
};

type AdminSpectatorMeta = {
  subscribedRoomId: string | null;
};

// --- Admin logs ---
type AdminLogEntry = {
  ts: number;
  type: string;
  roomId?: string;
  playerId?: string;
  name?: string;
  details?: unknown;
};
const adminLogs: AdminLogEntry[] = [];
const MAX_LOGS = 1000;
function addLog(entry: AdminLogEntry) {
  adminLogs.push(entry);
  if (adminLogs.length > MAX_LOGS) adminLogs.shift();
  // broadcast to admin WS listeners
  (wssAdmin.clients as Set<WebSocket>).forEach((clientWs) => {
    if (clientWs.readyState === clientWs.OPEN) {
      try { clientWs.send(JSON.stringify({ t: 'log', entry })); } catch {}
    }
  });
}

// --- Managers ---
class RoomManager {
  private rooms: Map<string, GameRoom> = new Map();
  private defaultConfig: RoomConfig;

  constructor(defaultConfig: RoomConfig) {
    this.defaultConfig = { ...defaultConfig };
  }

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
      emptySince: Date.now(),
      minimapSnapshot: null,
      minimapSnapshotAt: 0,
    };
    this.rooms.set(id, room);
    addLog({ ts: Date.now(), type: 'room_open', roomId: id, details: { config: room.config } });
    return room;
  }

  closeRoom(id: string, reason: 'manual' | 'timeout_empty' = 'manual'): boolean {
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
    addLog({ ts: Date.now(), type: 'room_close', roomId: id, details: { reason } });
    return true;
  }

  findRoomWithSlot(): GameRoom {
    for (const room of this.rooms.values()) {
      if (!room.isClosed && room.players.size < room.config.maxPlayers) return room;
    }
    return this.createRoom();
  }

  setDefaultConfig(config: RoomConfig) {
    this.defaultConfig = { ...config };
  }
}

let DEFAULT_ROOM_CONFIG: RoomConfig = {
  mapSize: 5000,
  maxPlayers: 100,
  foodCoveragePercent: 2,
  foodSpawnRatePerSecond: 200,
  emptyRoomTtlSeconds: 60,
  suctionRadiusMultiplier: 1,
  suctionStrengthMultiplier: 0.6,
  foodValueMultiplier: 1,
  foodNearPlayerTarget: 80,
  bodyRadiusMultiplier: 1,
  bodyLengthMultiplier: 1,
};

const roomManager = new RoomManager(DEFAULT_ROOM_CONFIG);
const wsToMeta = new WeakMap<WebSocket, ClientMeta>();
const adminWsToMeta = new WeakMap<WebSocket, AdminSpectatorMeta>();
const bannedNames = new Set<string>();
const metrics = {
  inputSpoofRejected: 0,
  inputInvalid: 0,
  inputThrottled: 0,
  roomsClosedTimeout: 0,
};

// --- Helpers ---
function distanceSquared(a: Vector2, b: Vector2): number {
  const dx = a.x - b.x; const dy = a.y - b.y; return dx*dx + dy*dy;
}

function computeRadius(score: number, config: RoomConfig): number {
  const base = 6 + Math.sqrt(Math.max(0, score)) * 0.6;
  const mult = Math.max(0.1, config.bodyRadiusMultiplier ?? 1);
  return base * mult;
}

function computeTargetLength(score: number, config: RoomConfig): number {
  const base = 120 + score * 2.5;
  const mult = Math.max(0.1, config.bodyLengthMultiplier ?? 1);
  return base * mult;
}

function computeSpeed(score: number, boosting: boolean): number {
  const base = 220 / (1 + 0.004 * Math.max(0, score));
  return boosting ? base * 1.55 : base;
}

function computeSuctionRadius(score: number, config: RoomConfig): number {
  const radiusMult = Math.max(0, config.suctionRadiusMultiplier ?? 1);
  if (radiusMult <= 0) return 0;
  const base = Math.min(600, 120 + Math.sqrt(Math.max(0, score)) * 14);
  return Math.min(2000, base * radiusMult);
}

function computeMaxTurnRate(score: number): number {
  // rad/s — very nimble when small, heavier when large
  const fast = 7.0; // small worm
  const slow = 2.2; // very large worm
  const t = Math.min(1, Math.sqrt(Math.max(0, score)) / 80);
  return slow + (fast - slow) * (1 - t);
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

const MINIMAP_FOOD_CELL_SIZE = 600;
const MAX_MINIMAP_FOOD_CELLS = 200;
const MINIMAP_REFRESH_MS = 500;
const INPUTS_PER_SECOND = 30;
const INPUT_BUCKET_CAPACITY = 45;

function buildMinimapFoods(foods: Food[]): { x: number; y: number; value: number; count: number }[] {
  const cells = new Map<string, { cx: number; cy: number; value: number; count: number }>();
  for (const food of foods) {
    const cx = Math.floor(food.position.x / MINIMAP_FOOD_CELL_SIZE);
    const cy = Math.floor(food.position.y / MINIMAP_FOOD_CELL_SIZE);
    const key = `${cx}:${cy}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { cx, cy, value: 0, count: 0 };
      cells.set(key, cell);
    }
    cell.value += food.value;
    cell.count += 1;
  }
  return Array.from(cells.values())
    .map((cell) => ({
      x: (cell.cx + 0.5) * MINIMAP_FOOD_CELL_SIZE,
      y: (cell.cy + 0.5) * MINIMAP_FOOD_CELL_SIZE,
      value: Math.round(cell.value * 10) / 10,
      count: cell.count,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_MINIMAP_FOOD_CELLS);
}

const SPAWN_PADDING = 200;
const SPAWN_ATTEMPTS = 20;
const MIN_SPAWN_DISTANCE = 900;

function pickSpawnPosition(room: GameRoom): Vector2 {
  if (room.players.size === 0) {
    const range = room.config.mapSize - SPAWN_PADDING;
    return {
      x: (Math.random() * 2 - 1) * range,
      y: (Math.random() * 2 - 1) * range,
    };
  }
  const range = room.config.mapSize - SPAWN_PADDING;
  let bestPos: Vector2 | null = null;
  let bestScore = -Infinity;
  for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
    const pos = {
      x: (Math.random() * 2 - 1) * range,
      y: (Math.random() * 2 - 1) * range,
    };
    let minDist2 = Number.POSITIVE_INFINITY;
    for (const other of room.players.values()) {
      const d2 = distanceSquared(pos, other.position);
      if (d2 < minDist2) minDist2 = d2;
    }
    if (minDist2 >= MIN_SPAWN_DISTANCE * MIN_SPAWN_DISTANCE) return pos;
    if (minDist2 > bestScore) {
      bestScore = minDist2;
      bestPos = pos;
    }
  }
  return bestPos ?? { x: (Math.random() * 2 - 1) * range, y: (Math.random() * 2 - 1) * range };
}

function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  const twoPi = Math.PI * 2;
  const wrapped = angle + Math.PI;
  const normalized = wrapped - Math.floor(wrapped / twoPi) * twoPi;
  return normalized - Math.PI;
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
    inputAllowance: INPUT_BUCKET_CAPACITY,
    inputRefillAt: Date.now(),
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
        const spawnPos = pickSpawnPosition(room);
        const spawnDir = Math.random() * Math.PI * 2;
        const player: Player = {
          id: playerId,
          name,
          score: 10,
          position: { x: spawnPos.x, y: spawnPos.y },
          directionRad: spawnDir,
          targetDirectionRad: spawnDir,
          boosting: false,
          ws,
          bodyPoints: [{ x: spawnPos.x, y: spawnPos.y }],
        };
        room.players.set(playerId, player);
        room.emptySince = null;
        meta.roomId = room.id;
        addLog({ ts: Date.now(), type: 'player_join', roomId: room.id, playerId, name });
        ws.send(JSON.stringify({ t: 'joined', roomId: room.id, playerId }));
        return;
      }

      // Player input (to be validated in simulation tick)
      if (msg?.t === 'input') {
        const meta = wsToMeta.get(ws);
        if (!meta?.roomId) return;
        const room = roomManager.getRoom(meta.roomId);
        if (!room) return;
        if (typeof msg.playerId !== 'string') return;
        const player = room.players.get(msg.playerId);
        if (!player) return;
        if (player.ws !== ws) {
          metrics.inputSpoofRejected += 1;
          addLog({ ts: Date.now(), type: 'player_input_spoof', roomId: room.id, playerId: msg.playerId });
          return;
        }
        const now = Date.now();
        const elapsedSec = (now - meta.inputRefillAt) / 1000;
        if (elapsedSec > 0) {
          meta.inputAllowance = Math.min(INPUT_BUCKET_CAPACITY, meta.inputAllowance + elapsedSec * INPUTS_PER_SECOND);
          meta.inputRefillAt = now;
        }
        if (meta.inputAllowance < 1) {
          metrics.inputThrottled += 1;
          addLog({ ts: Date.now(), type: 'player_input_throttled', roomId: room.id, playerId: player.id });
          return;
        }
        meta.inputAllowance -= 1;
        meta.lastInputAt = now;
        if (typeof msg.directionRad === 'number') {
          if (!Number.isFinite(msg.directionRad)) {
            metrics.inputInvalid += 1;
            addLog({ ts: Date.now(), type: 'player_input_invalid', roomId: room.id, playerId: player.id, details: { directionRad: msg.directionRad } });
            return;
          }
          player.targetDirectionRad = normalizeAngle(msg.directionRad);
        }
        if (typeof msg.boosting === 'boolean') player.boosting = msg.boosting;
        addLog({ ts: Date.now(), type: 'player_input', roomId: room.id, playerId: player.id, details: { directionRad: player.targetDirectionRad, boosting: player.boosting } });
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
        if (room.players.size === 0) room.emptySince = Date.now();
        addLog({ ts: Date.now(), type: 'player_leave', roomId: meta.roomId, playerId: meta.id });
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
    let noPongFor = 0;
    if (meta.lastPingSentAt) {
      noPongFor = meta.lastPongAt ? now - meta.lastPongAt : now - meta.lastPingSentAt;
    }
    const idleFor = now - (meta.lastMessageAt ?? 0);
    if (noPongFor > 30000 || idleFor > 600000) { // 30s no pong or 10 min idle
      try { client.close(4002, 'inactive'); } catch {}
      wsToMeta.delete(client);
    }
  });
}, 5000);

// --- Simulation loop per room ---
const TICK_RATE = 20; // 20 Hz
const BROADCAST_RATE = 20; // 20 Hz snapshots to players for very smooth motion (per-recipient culling keeps cost low)
setInterval(() => {
  const dt = 1 / TICK_RATE;
  for (const room of roomManager.listRooms()) {
    if (room.isClosed) continue;
    if (room.players.size === 0) {
      if (!room.emptySince) room.emptySince = Date.now();
      const ttlSec = Math.max(0, room.config.emptyRoomTtlSeconds);
      if (ttlSec > 0 && room.emptySince && Date.now() - room.emptySince >= ttlSec * 1000) {
        metrics.roomsClosedTimeout += 1;
        roomManager.closeRoom(room.id, 'timeout_empty');
        continue;
      }
    } else {
      room.emptySince = null;
    }
    if (room.players.size === 0) {
      continue;
    }
    const t0 = (globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now();
    // Move players (bounded turn rate)
    for (const player of room.players.values()) {
      // dynamic turn rate: higher when small so the player can coil
      const maxTurn = computeMaxTurnRate(player.score) * dt;
      player.directionRad = rotateTowards(player.directionRad, player.targetDirectionRad, maxTurn);
      const speed = computeSpeed(player.score, player.boosting);
      const dx = Math.cos(player.directionRad) * speed * dt;
      const dy = Math.sin(player.directionRad) * speed * dt;
      player.position.x = Math.max(-room.config.mapSize, Math.min(room.config.mapSize, player.position.x + dx));
      player.position.y = Math.max(-room.config.mapSize, Math.min(room.config.mapSize, player.position.y + dy));
      player.bodyPoints.push({ x: player.position.x, y: player.position.y });
      trimBodyToLength(player.bodyPoints, computeTargetLength(player.score, room.config));
      if (player.boosting && player.score > 1) {
        player.score -= Math.max(0.1, Math.min(1.5, player.score * 0.002));
        if (Math.random() < 0.3) {
          room.foods.push({ id: uuidv4(), position: { x: player.position.x + jitter(8), y: player.position.y + jitter(8) }, value: 0.5 });
        }
      }
    }

    // Food consumption + suction (attract nearby food)
      const toKeep: Food[] = [];
      for (const food of room.foods) {
        let eaten = false;
        for (const player of room.players.values()) {
        const bodyR = computeRadius(player.score, room.config);
        const suckR = computeSuctionRadius(player.score, room.config);
        const dx = food.position.x - player.position.x;
        const dy = food.position.y - player.position.y;
        const d2 = dx*dx + dy*dy;
        // eat if touching body
        if (d2 <= bodyR * bodyR) {
          const gain = food.value * Math.max(0, room.config.foodValueMultiplier ?? 1);
          player.score += gain;
          eaten = true; break;
        }
        // suction if in suction range
        if (suckR > 0 && d2 <= suckR * suckR) {
          const d = Math.max(1, Math.sqrt(d2));
          const basePull = Math.min(220, 140 + Math.sqrt(Math.max(0, player.score)) * 6);
          const pull = basePull * Math.max(0, room.config.suctionStrengthMultiplier ?? 1);
          if (pull > 0) {
            food.position.x -= (dx / d) * (pull * dt);
            food.position.y -= (dy / d) * (pull * dt);
          }
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
      const aR = computeRadius(a.score, room.config);
      // NOTE: in slither-like games, self-collision does not kill. Skip self body checks.
      if (deaths.includes(a.id)) continue;
      for (let j = 0; j < playersArr.length; j++) {
        if (i === j) continue;
        const b = playersArr[j];
        const bR = computeRadius(b.score, room.config);
        // quick reject if heads are far apart
        const far2 = (aR + bR + 200) * (aR + bR + 200);
        if (distanceSquared(a.position, b.position) > far2) continue;
        // head vs body segments of b, skip last 12 points near b's head
        for (let k = 0; k < b.bodyPoints.length - 12; k += 3) {
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
        const playerMeta = wsToMeta.get(p.ws);
        if (playerMeta) {
          playerMeta.roomId = null;
          playerMeta.lastInputAt = null;
        }
        if (room.players.size === 0) room.emptySince = Date.now();
      }
    }

    // Spawn food clusters to maintain density
    const desiredFoodCount = Math.floor((room.config.foodCoveragePercent / 100) * 2000);
    if (room.foods.length < desiredFoodCount) {
      const center: Vector2 = { x: (Math.random() * 2 - 1) * room.config.mapSize, y: (Math.random() * 2 - 1) * room.config.mapSize };
      const clusterSize = 15 + Math.floor(Math.random() * 40);
      for (let n = 0; n < clusterSize; n++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = Math.random() * 80 + 20;
        const pos = { x: center.x + Math.cos(angle) * radius + jitter(8), y: center.y + Math.sin(angle) * radius + jitter(8) };
        room.foods.push({ id: uuidv4(), position: pos, value: 1 + Math.random() * 3 });
      }
    }
    // Ensure some food near each player to avoid empty screen
    const perPlayerFoodTarget = Math.max(0, room.config.foodNearPlayerTarget ?? 80);
    for (const p of room.players.values()) {
      let near = 0
      const radius = 1500
      const r2 = radius * radius
      for (const f of room.foods) {
        const dx = f.position.x - p.position.x; const dy = f.position.y - p.position.y
        if (dx*dx + dy*dy <= r2) { near++; if (near >= perPlayerFoodTarget) break }
      }
      if (near < perPlayerFoodTarget) {
        const need = perPlayerFoodTarget - near
        for (let i = 0; i < need; i++) {
          const angle = Math.random() * Math.PI * 2
          const dist = 900 + Math.random() * 600
          const clamp = (v: number) => Math.max(-room.config.mapSize, Math.min(room.config.mapSize, v))
          const pos = {
            x: clamp(p.position.x + Math.cos(angle) * dist + jitter(40)),
            y: clamp(p.position.y + Math.sin(angle) * dist + jitter(40)),
          }
          room.foods.push({ id: uuidv4(), position: pos, value: 1 })
        }
      }
    }
    const t1 = (globalThis as any).performance?.now ? (globalThis as any).performance.now() : Date.now();
    const dur = t1 - t0;
    room.tickDurationsMs.push(dur);
    if (room.tickDurationsMs.length > 200) room.tickDurationsMs.shift();
  }
}, 1000 / TICK_RATE);

// Broadcast snapshots to players (per-player filtered payload)
setInterval(() => {
  for (const room of roomManager.listRooms()) {
    if (room.isClosed) continue;
    const now = Date.now();
    const lb = Array.from(room.players.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((p) => ({ id: p.id, name: p.name, score: Math.round(p.score) }));
    if (!room.minimapSnapshot || now - room.minimapSnapshotAt >= MINIMAP_REFRESH_MS) {
      const minimapPlayers = Array.from(room.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        score: Math.round(p.score),
        position: { x: Math.round(p.position.x), y: Math.round(p.position.y) },
      }));
      const minimapFoods = buildMinimapFoods(room.foods);
      room.minimapSnapshot = { players: minimapPlayers, foods: minimapFoods };
      room.minimapSnapshotAt = now;
    }
    const minimapSnapshot = room.minimapSnapshot ?? { players: [], foods: [] };
    for (const recipient of room.players.values()) {
      if (recipient.ws.readyState !== recipient.ws.OPEN) continue;
      // foods near recipient
      const viewR = 1800;
      const r2 = viewR * viewR;
      const visibleFoods: { id: string; position: { x: number; y: number }; value: number }[] = [];
      for (const f of room.foods) {
        const dx = f.position.x - recipient.position.x; const dy = f.position.y - recipient.position.y;
        if (dx*dx + dy*dy <= r2) {
          visibleFoods.push({ id: f.id, position: { x: Math.round(f.position.x), y: Math.round(f.position.y) }, value: Math.round(f.value * 10) / 10 });
          if (visibleFoods.length >= 250) break;
        }
      }
      // players near recipient (always include self)
      const viewPlayersR = 2600;
      const pr2 = viewPlayersR * viewPlayersR;
      const playersPayload: { id: string; name: string; score: number; position: { x: number; y: number } }[] = [];
      for (const p of room.players.values()) {
        if (p.id === recipient.id) {
          playersPayload.push({ id: p.id, name: p.name, score: Math.round(p.score), position: { x: Math.round(p.position.x), y: Math.round(p.position.y) } });
          continue;
        }
        const dx = p.position.x - recipient.position.x; const dy = p.position.y - recipient.position.y;
        if (dx*dx + dy*dy <= pr2) {
          playersPayload.push({ id: p.id, name: p.name, score: Math.round(p.score), position: { x: Math.round(p.position.x), y: Math.round(p.position.y) } });
          if (playersPayload.length >= 40) break;
        }
      }
      // provide recipient's own body (decimated)
      const body = room.players.get(recipient.id)?.bodyPoints ?? [];
      const selfBody: { x: number; y: number }[] = [];
      for (let i = Math.max(0, body.length - 180); i < body.length; i += 3) {
        const pt = body[i];
        selfBody.push({ x: Math.round(pt.x), y: Math.round(pt.y) });
      }
      const payload = JSON.stringify({
        t: 'state',
        roomId: room.id,
        leaderboard: lb,
        players: playersPayload,
        foods: visibleFoods,
        selfBody,
        mapSize: room.config.mapSize,
        bodyRadiusMultiplier: room.config.bodyRadiusMultiplier,
        bodyLengthMultiplier: room.config.bodyLengthMultiplier,
        serverNow: now,
        minimap: minimapSnapshot,
      });
      try { recipient.ws.send(payload); } catch {}
    }
    room.lastBroadcastAt = now;
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
  const cfgRaw = req.body?.config || {};
  const parsed = RoomConfigSchema.safeParse(cfgRaw);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_CONFIG', details: parsed.error.issues });
  const room = roomManager.createRoom(parsed.data);
  res.json({ roomId: room.id });
});

const RoomConfigSchema = z.object({
  mapSize: z.number().min(1000).max(20000).optional(),
  maxPlayers: z.number().min(2).max(500).optional(),
  foodCoveragePercent: z.number().min(0).max(50).optional(),
  foodSpawnRatePerSecond: z.number().min(0).max(10000).optional(),
  emptyRoomTtlSeconds: z.number().min(0).max(3600).optional(),
  suctionRadiusMultiplier: z.number().min(0).max(5).optional(),
  suctionStrengthMultiplier: z.number().min(0).max(5).optional(),
  foodValueMultiplier: z.number().min(0).max(10).optional(),
  foodNearPlayerTarget: z.number().min(0).max(400).optional(),
  bodyRadiusMultiplier: z.number().min(0).max(10).optional(),
  bodyLengthMultiplier: z.number().min(0).max(10).optional(),
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
  roomManager.setDefaultConfig(DEFAULT_ROOM_CONFIG);
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
  const meta = wsToMeta.get(player.ws);
  if (meta) meta.roomId = null;
  addLog({ ts: Date.now(), type: 'admin_kick', roomId: room.id, playerId });
  res.json({ ok: true });
});

app.post('/admin/ban', (req, res) => {
  const rawName = typeof req.body?.name === 'string' ? req.body.name : '';
  const name = rawName.trim();
  if (!name) return res.status(400).json({ error: 'INVALID_NAME' });
  bannedNames.add(name.toLowerCase());
  addLog({ ts: Date.now(), type: 'admin_ban', details: { name } });
  // disconnect any matching players
  for (const room of roomManager.listRooms()) {
    for (const [id, p] of room.players) {
      if (p.name.toLowerCase() === name.toLowerCase()) {
        try { p.ws.close(4001, 'banned'); } catch {}
        room.players.delete(id);
        const m = wsToMeta.get(p.ws);
        if (m) m.roomId = null;
        addLog({ ts: Date.now(), type: 'admin_ban_disconnect', roomId: room.id, playerId: id, name: p.name });
      }
    }
  }
  res.json({ ok: true });
});

// Admin logs endpoint
app.get('/admin/logs', (_req, res) => {
  res.json({ logs: adminLogs });
});

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, () => console.log(`server listening on http://localhost:${PORT}`));
