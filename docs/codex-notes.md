# Codex Notes

Quick references while iterating on Wormy 5.0.

## Simulation checkpoints

- `server/src/index.ts`
  - Tick loop (20 Hz) starts around the food/chunk logic.
  - Input rate limiting: `INPUTS_PER_SECOND` & `INPUT_BUCKET_CAPACITY`.
  - Food grid helpers: `chunkKey`, `ensureChunk`, `FoodCell`.
  - Bonus pellets: `spawnBonusFood`.
  - Minimap cache: `room.minimapSnapshot` (refresh every 500 ms).

## Rendering cues

- `client/src/game/GameScene.ts`
  - Self body uses authoritative `selfBody` path (`serverSelfBody`).
  - Remote interpolate/extrapolate using `playerVelocity`.
  - Trails stored in `playerTrails` (trim to 0.75 target length).

- `client/src/App.tsx`
  - Input smoothing by `lastAngleRef` + normalized delta.
  - Death overlay resets refs and replays after 2 s.
  - Minimap ring radius corresponds to server food visibility (1800 units).

## Todo ideas

- Hook bonus pellet stats into admin dashboard.
- Expose input rate limits through config endpoint (per room/default).
- Lerp leaderboard transitions for a softer HUD update.

## Useful commands

```bash
# build everything
npm --prefix server run build
npm --prefix client run build
npm --prefix admin run build

# wipe Vite caches (permission issues on Windows WSL)
rm -rf client/node_modules/.vite
```

_Last updated: keep in sync with feature work._
