# Wormy 5.0 – Slither-like (Server authoritative)

Monorepo structure:
- `server/`: Node.js + TypeScript, Express + ws. Rooms, simulation, anti-cheat, admin REST.
- `client/`: React + Vite + TypeScript. Canvas rendering, HUD, minimap.
- `admin/`: React + Vite + TypeScript. Stats, controls, spectator mode.

Scripts:
- Install all: run `npm i` in each workspace
- Dev server: `npm run dev` in `server/`
- Dev client: `npm run dev` in `client/`
- Dev admin: `npm run dev` in `admin/`

Env (server):
- `PORT` (default 4000)
- `ADMIN_TOKEN` (simple bearer token for admin routes)

Notes:
- Server is authoritative: clients only send inputs; server validates and simulates.
