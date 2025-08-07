import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'dev-admin';
app.use('/admin', (req, res, next) => {
    const token = req.header('authorization')?.replace('Bearer ', '');
    if (token !== ADMIN_TOKEN)
        return res.status(401).json({ error: 'Unauthorized' });
    next();
});
app.get('/admin/stats', (_req, res) => {
    res.json({ rooms: [], totals: { players: 0 } });
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ t: 'welcome' }));
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(String(data));
            if (msg?.t === 'ping')
                ws.send(JSON.stringify({ t: 'pong' }));
        }
        catch {
        }
    });
});
const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, () => console.log());
