import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import cors from 'cors';

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
  res.json({ rooms: [], totals: { players: 0 } });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

type ClientMeta = {
  id: string;
  roomId: string | null;
  lastPingId: number | null;
  lastPingSentAt: number | null;
  rttMs: number | null;
};

const wsToMeta = new WeakMap<WebSocket, ClientMeta>();

wss.on('connection', (ws: WebSocket) => {
  wsToMeta.set(ws, {
    id: Math.random().toString(36).slice(2),
    roomId: null,
    lastPingId: null,
    lastPingSentAt: null,
    rttMs: null,
  });
  ws.send(JSON.stringify({ t: 'welcome' }));
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data));
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

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, () => console.log(`server listening on http://localhost:${PORT}`));
