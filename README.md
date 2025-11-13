# Wormy 5.0

Arcade multiplayer inspired by Slither.io where the server drives the simulation and the clients only send their intended movement. The project is split into three workspaces:

- **`server/`** – Node.js + TypeScript (Express + ws). Handles rooms, simulation at 20 Hz, anti-cheat input validation, adaptive food spawning, and admin REST/WS.
- **`client/`** – React + Vite + TypeScript. Renders the arena with Phaser, smooths local and remote snakes, shows the HUD/minimap/overlays.
- **`admin/`** – React + Vite + TypeScript dashboard. Live stats, kick/ban, room config, spectator mode.

## Quick start

Install dependencies once per workspace:

```bash
npm install --prefix server
npm install --prefix client
npm install --prefix admin   # optional but recommended
```

Run the three entry points in separate terminals:

```bash
# 1. Simulation server (requires an admin token)
cd server
export ADMIN_TOKEN=dev-admin   # choose any non-empty value
npm run dev

# 2. Game client
cd client
npm run dev            # http://localhost:5173

# 3. Admin dashboard (optional)
cd admin
npm run dev            # http://localhost:5174
```

Server environment variables:

| Variable       | Description                                         | Default  |
| -------------- | --------------------------------------------------- | -------- |
| `PORT`         | HTTP port for REST + WebSocket endpoints            | `4000`   |
| `ADMIN_TOKEN`  | Bearer token protecting `/admin/*` + `/admin-ws`    | _none_ → **required** |

## Controls & gameplay

- **Mouse** – point in the direction you want to head. Steering is rate-limited server side.
- **Keyboard** – use arrow keys or WASD for steering if you prefer not to move the mouse.
- **Space** – boost speed at the cost of your length. Boosting leaves low-value pellets behind.
- **Objective** – eat pellets (static, dropped, or bonus) to grow in length/thickness. Collide head-first into someone’s body to eliminate them and harvest their remains.

Key simulation details:

- Adaptive food density per map chunk (spawns ring further from the player to keep the edge filled).
- Death drops decay over ~15 s, preventing infinite junk.
- Auto room creation/cleanup, ping/latency tracking, anti-spoof + rate limiting on inputs.
- Minimap shows the full map with your vision radius, top players, and food heat spots.

## Admin dashboard

Visit `http://localhost:5174` while the admin dev server is running:

- Enter the same `ADMIN_TOKEN` to authenticate.
- Open/close rooms, edit room/default config (max players, map size, empty-room TTL, food density, bonus spawn rate).
- Live stats panel with p95 tick, broadcast Hz, process memory, input rejection counters.
- Live logs + WebSocket spectator view (top-down positions of every player).
- Tweak magnetism via `suctionStrengthMultiplier` (overall pull) and `suctionCatchupMultiplier` (close-range chase speed) globally or per room.
- Preview rooms using the canvas mini-map: foods appear as green heat spots and every player is plotted with name+score on the full map extent.

## Scripts

- `npm run dev` – Vite dev server (client/admin) or tsx watch (server).
- `npm run build` – TypeScript compile (server) or Vite production build (client/admin).
- `npm run start` (server) – run compiled JS from `dist/`.

## Tech stack

- **Backend**: Node.js, Express, ws, Zod, UUID.
- **Frontend**: React, Vite, Phaser, modern HUD with Inter/Quantico fonts.
- **Tooling**: TypeScript, ESLint, pnpm-compatible scripts (but repo uses npm lockfiles).

Feel free to open multiple client windows to simulate matches locally. The server is authoritative, so only direction/boost inputs travel over the network; positions/sizes are never trusted from the client.
