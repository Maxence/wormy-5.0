import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import Phaser from 'phaser'
import GameScene from './game/GameScene'
import type { WsState as SceneWsState } from './game/GameScene'

type Vector2 = { x: number; y: number }
type PlayerState = { id: string; name: string; score: number; position: Vector2 }
type FoodState = { id: string; position: Vector2; value: number }
type MinimapPlayer = { id: string; name: string; score: number; position: Vector2 }
type MinimapFoodCell = { x: number; y: number; value: number; count: number }
type WsState = {
  t: 'state'
  roomId: string
  leaderboard: { id: string; name: string; score: number }[]
  players: PlayerState[]
  foods: FoodState[]
  mapSize: number
  bodyRadiusMultiplier?: number
  bodyLengthMultiplier?: number
  serverNow: number
  minimap?: { players: MinimapPlayer[]; foods: MinimapFoodCell[] }
}
type DeathInfo = { score: number; rank: number | null }
type WsMessage =
  | { t: 'welcome' }
  | { t: 'ping'; pingId: number }
  | { t: 'pong'; now?: number; pingId?: number | null }
  | { t: 'latency'; rttMs: number }
  | { t: 'joined'; roomId: string; playerId: string }
  | { t: 'dead' }
  | WsState

const twoPi = Math.PI * 2
function normalizeAngle(angle: number): number {
  let a = angle
  while (a <= -Math.PI) a += twoPi
  while (a > Math.PI) a -= twoPi
  return a
}

function App() {
  const [rttMs, setRttMs] = useState<number | null>(null)
  const [status, setStatus] = useState<'disconnected'|'connecting'|'connected'>('disconnected')
  const [playerName, setPlayerName] = useState('Player')
  const [roomId, setRoomId] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [leaderboard, setLeaderboard] = useState<{ id: string; name: string; score: number }[]>([])
  const [minimapPlayers, setMinimapPlayers] = useState<MinimapPlayer[]>([])
  const [minimapFoods, setMinimapFoods] = useState<MinimapFoodCell[]>([])
  const [mapSize, setMapSize] = useState<number>(5000)
  const [deathInfo, setDeathInfo] = useState<DeathInfo | null>(null)
  const prevSnapshotRef = useRef<WsState | null>(null)
  const currSnapshotRef = useRef<WsState | null>(null)
  const [boosting, setBoosting] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const [joinError, setJoinError] = useState<string | null>(null)
  const lastPings = useRef<Map<number, number>>(new Map())
  const minimapRef = useRef<HTMLCanvasElement | null>(null)
  const phaserContainerRef = useRef<HTMLDivElement | null>(null)
  const phaserSceneRef = useRef<GameScene | null>(null)
  const [fps, setFps] = useState<number | null>(null)
  type Particle = { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number; color: string }
  const particlesRef = useRef<Particle[]>([])
  const roomIdRef = useRef<string | null>(roomId)
  const statusRef = useRef<typeof status>(status)
  const playerIdRef = useRef<string | null>(playerId)
  const mousePosRef = useRef<{ x: number; y: number }>({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const lastAngleRef = useRef<number | null>(null)
  const pendingHudRef = useRef<{
    leaderboard: { id: string; name: string; score: number }[]
    minimapPlayers: MinimapPlayer[]
    minimapFoods: MinimapFoodCell[]
    mapSize: number
  } | null>(null)

  const wsUrlCandidates = useMemo(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const hostCandidates = [location.hostname, 'localhost', '127.0.0.1'].filter((h): h is string => Boolean(h))
    const uniqueHosts = Array.from(new Set(hostCandidates))
    const port = 4000
    return uniqueHosts.map(h => `${proto}://${h}:${port}/ws`)
  }, [])
  const urlIndexRef = useRef(0)

  // Connect and join on demand
  const connectAndJoin = () => {
    const existing = wsRef.current
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.send(JSON.stringify({ t: 'hello', name: playerName }))
      return
    }
    if (existing && existing.readyState === WebSocket.CONNECTING) {
      return
    }
    setStatus('connecting')
    setJoinError(null)
    const attemptIndex = urlIndexRef.current % wsUrlCandidates.length
    const url = wsUrlCandidates[attemptIndex]
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.onopen = () => {
      setStatus('connected')
      ws.send(JSON.stringify({ t: 'hello', name: playerName }))
    }
    ws.onclose = () => {
      const shouldRetry = !roomIdRef.current
      setStatus('disconnected')
      // rotate url for next connect attempt
      urlIndexRef.current = (urlIndexRef.current + 1) % wsUrlCandidates.length
      // auto-retry after short delay if not joined
      if (shouldRetry) {
        setTimeout(() => {
          if (wsRef.current === ws && statusRef.current !== 'connected' && !roomIdRef.current) connectAndJoin()
        }, 1500)
      }
    }
    ws.onerror = () => {
      if (wsUrlCandidates.length && ((attemptIndex + 1) % wsUrlCandidates.length === 0)) {
        setJoinError('WS_CONNECT_FAILED')
      }
    }
    ws.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(String(event.data))
        if (msg.t === 'ping' && typeof msg.pingId === 'number') {
          ws.send(JSON.stringify({ t: 'pong', pingId: msg.pingId }))
        } else if (msg.t === 'latency') {
          setRttMs(msg.rttMs)
        } else if (msg.t === 'pong' && typeof msg.pingId === 'number') {
          const sentAt = lastPings.current.get(msg.pingId)
          if (typeof sentAt === 'number') {
            setRttMs(Date.now() - sentAt)
            lastPings.current.delete(msg.pingId)
          }
        } else if (msg.t === 'joined') {
          setRoomId(msg.roomId)
          setPlayerId(msg.playerId)
          setJoinError(null)
          setDeathInfo(null)
          lastAngleRef.current = null
        } else if ((msg as any).t === 'error') {
          const anyMsg = msg as any
          setJoinError(anyMsg.error || 'JOIN_FAILED')
        } else if (msg.t === 'dead') {
          const snap = currSnapshotRef.current
          const currentPlayerId = playerIdRef.current
          const me = snap?.players.find(p => p.id === currentPlayerId)
          if (me) {
            for (let i = 0; i < 60; i++) {
              const a = Math.random() * Math.PI * 2
              const sp = 40 + Math.random() * 140
              particlesRef.current.push({
                x: me.position.x, y: me.position.y,
                vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                life: 0, maxLife: 0.7 + Math.random() * 0.6,
                size: 2 + Math.random() * 3,
                color: 'rgba(241,196,15,1)'
              })
            }
          }
          const scoreVal = me ? Math.round(me.score) : 0
          const rankIndex = snap?.leaderboard?.findIndex?.(p => p.id === currentPlayerId) ?? -1
          setDeathInfo({ score: scoreVal, rank: rankIndex >= 0 ? rankIndex + 1 : null })
          // show a brief banner or change status if needed
          setStatus('disconnected')
          setRoomId(null)
          setPlayerId(null)
          setMinimapPlayers([])
          setMinimapFoods([])
          pendingHudRef.current = null
          prevSnapshotRef.current = null
          currSnapshotRef.current = null
          setBoosting(false)
          lastAngleRef.current = null
        } else if (msg.t === 'state') {
          prevSnapshotRef.current = currSnapshotRef.current
          currSnapshotRef.current = msg
          pendingHudRef.current = {
            leaderboard: msg.leaderboard,
            minimapPlayers: msg.minimap?.players ?? [],
            minimapFoods: msg.minimap?.foods ?? [],
            mapSize: msg.mapSize
          }
          const scene = phaserSceneRef.current
          if (scene) scene.setSnapshot(msg as unknown as SceneWsState, playerIdRef.current)
        }
      } catch {}
    }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      try { wsRef.current?.close() } catch {}
    }
  }, [])

  useEffect(() => {
    roomIdRef.current = roomId
  }, [roomId])

  useEffect(() => {
    playerIdRef.current = playerId
  }, [playerId])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    const onMove = (ev: MouseEvent) => {
      mousePosRef.current = { x: ev.clientX, y: ev.clientY }
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => { if (e.code === 'Space') setBoosting(true) }
    const onUp = (e: KeyboardEvent) => { if (e.code === 'Space') setBoosting(false) }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      if (!wsRef.current || !playerId) return
      const scene = phaserSceneRef.current as (GameScene & { screenToWorld?: (x: number, y: number) => { x: number; y: number } }) | null
      const snap = currSnapshotRef.current
      let targetWorld: { x: number; y: number } | null = null
      if (scene) {
        const direct = (scene.getPointerWorld?.() as { x: number; y: number } | undefined) || null
        if (direct) targetWorld = direct
        else if (scene.screenToWorld) {
          const mp = mousePosRef.current
          targetWorld = scene.screenToWorld(mp.x, mp.y)
        }
      }
      let outAngle = lastAngleRef.current ?? 0
      if (targetWorld && snap) {
        const me = snap.players.find(p => p.id === playerId)
        if (me) {
          const raw = Math.atan2(targetWorld.y - me.position.y, targetWorld.x - me.position.x)
          const prev = lastAngleRef.current ?? raw
          const delta = normalizeAngle(raw - prev)
          const smoothed = prev + delta * 0.45
          lastAngleRef.current = smoothed
          outAngle = smoothed
        }
      }
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ t: 'input', playerId, directionRad: outAngle, boosting }))
      }
    }, 33)
    return () => clearInterval(id)
  }, [playerId, boosting])

  // Initialize Phaser game
  useEffect(() => {
    if (!phaserContainerRef.current) return
    const cfg: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      width: window.innerWidth,
      height: window.innerHeight,
      parent: phaserContainerRef.current,
      scene: [GameScene],
      physics: { default: 'arcade' },
      backgroundColor: '#0a0a0a'
    }
    const game = new Phaser.Game(cfg)
    const captureScene = () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const scene = (game.scene.getScene(GameScene.KEY) as any) as GameScene
        if (scene) phaserSceneRef.current = scene
        else setTimeout(captureScene, 50)
      } catch { setTimeout(captureScene, 50) }
    }
    captureScene()
    const onResize = () => {
      game.scale.resize(window.innerWidth, window.innerHeight)
      const mini = minimapRef.current; if (mini) { mini.width = 200; mini.height = 200 }
    }
    window.addEventListener('resize', onResize)
    return () => { phaserSceneRef.current = null; window.removeEventListener('resize', onResize); game.destroy(true) }
  }, [])

  // Heartbeat ping using wsRef safely; also keep-alive to avoid disconnects
  useEffect(() => {
    const id = setInterval(() => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const pingId = Date.now()
      lastPings.current.set(pingId, Date.now())
      ws.send(JSON.stringify({ t: 'ping', pingId }))
    }, 5000)
    return () => clearInterval(id)
  }, [])

  // Feed snapshots into Phaser scene
  useEffect(() => {
    const scene = phaserSceneRef.current
    if (scene && currSnapshotRef.current) scene.setSnapshot(currSnapshotRef.current as unknown as SceneWsState, playerId)
  }, [leaderboard, playerId, mapSize])

  // Poll FPS from Phaser loop
  useEffect(() => {
    const id = setInterval(() => {
      const scene = phaserSceneRef.current as unknown as { game?: any } | null
      const val = scene?.game?.loop?.actualFps
      if (typeof val === 'number' && isFinite(val)) setFps(Math.round(val))
    }, 500)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      const pending = pendingHudRef.current
      if (!pending) return
      pendingHudRef.current = null
      setLeaderboard(pending.leaderboard)
      setMinimapPlayers(pending.minimapPlayers)
      setMinimapFoods(pending.minimapFoods)
      setMapSize(pending.mapSize)
    }, 160)
    return () => clearInterval(id)
  }, [])

  // Draw minimap from latest snapshot
  useEffect(() => {
    const mini = minimapRef.current
    if (!mini) return
    const ctx = mini.getContext('2d')
    if (!ctx) return
    mini.width = 200; mini.height = 200
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, mini.width, mini.height)
    const ms = mapSize || 5000
    const toMini = (x: number, y: number) => {
      const nx = (x + ms) / (2 * ms)
      const ny = (y + ms) / (2 * ms)
      return { x: nx * mini.width, y: ny * mini.height }
    }
    // food density blobs
    ctx.fillStyle = 'rgba(39, 174, 96, 0.55)'
    for (const cell of minimapFoods) {
      const pos = toMini(cell.x, cell.y)
      const radius = Math.max(1.5, Math.sqrt(Math.max(0.1, cell.value)) * 0.8)
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2)
      ctx.fill()
    }
    // players everywhere on map
    for (const p of minimapPlayers) {
      const pos = toMini(p.position.x, p.position.y)
      const baseSize = Math.max(1.8, Math.log10(1 + Math.max(0, p.score)) * 1.6)
      if (p.id === playerId) {
        ctx.fillStyle = '#f1c40f'
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, baseSize + 1.5, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#d35400'
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, baseSize, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.fillStyle = '#3498db'
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, baseSize, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    const me = minimapPlayers.find(p => p.id === playerId)
    if (me) {
      const viewRadiusWorld = 1800
      const center = toMini(me.position.x, me.position.y)
      const scale = mini.width / (2 * ms)
      const viewRadius = Math.max(4, viewRadiusWorld * scale)
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(center.x, center.y, viewRadius, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.strokeStyle = '#444'
    ctx.strokeRect(0.5, 0.5, mini.width - 1, mini.height - 1)
  }, [minimapPlayers, minimapFoods, mapSize, playerId])

  const statusTone = status === 'connected' ? 'success' : status === 'connecting' ? 'warning' : 'danger'
  const statusText = status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Disconnected'
  const pingText = rttMs != null ? `${rttMs} ms` : '—'
  const fpsText = fps != null ? `${fps}` : '—'
  const shortRoomId = roomId ? roomId.slice(0, 8) : '—'
  const shortPlayerId = playerId ? playerId.slice(0, 8) : '—'
  const leaderboardTop = leaderboard.slice(0, 8)
  const wsDisplayHost = `${location.hostname || 'localhost'}:4000`

  return (
    <div className="game-shell">
      <div ref={phaserContainerRef} className="game-canvas" />

      <div className="hud-panel hud-panel--leaderboard">
        <div className="hud-header">
          <span className="hud-kicker">Leaderboard</span>
          <span className="hud-title">Top snakes</span>
        </div>
        <ol className="leaderboard">
          {leaderboardTop.length === 0 ? (
            <li className="leaderboard-item leaderboard-item--empty">Waiting for players…</li>
          ) : (
            leaderboardTop.map((entry, index) => (
              <li
                key={entry.id}
                className={`leaderboard-item ${entry.id === playerId ? 'leaderboard-item--me' : ''}`}
              >
                <span className="leaderboard-rank">{index + 1}</span>
                <span className="leaderboard-name">{entry.name || 'Anon'}</span>
                <span className="leaderboard-score">{entry.score}</span>
              </li>
            ))
          )}
        </ol>
      </div>

      <div className="hud-panel hud-panel--session">
        <div className="hud-header">
          <span className="hud-kicker">Session</span>
          <span className="hud-title">Control center</span>
        </div>
        <label className="field">
          <span className="field-label">Nickname</span>
          <input className="input" value={playerName} onChange={(e) => setPlayerName(e.target.value)} maxLength={20} />
        </label>
        <div className="stat-grid">
          <div className="stat">
            <span className="stat-label">Status</span>
            <span className={`status-pill status-pill--${statusTone}`}>{statusText}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Ping</span>
            <span className="stat-value">{pingText}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Room</span>
            <span className="stat-value">{shortRoomId}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Player ID</span>
            <span className="stat-value">{shortPlayerId}</span>
          </div>
          <div className="stat">
            <span className="stat-label">FPS</span>
            <span className="stat-value">{fpsText}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Boost</span>
            <span className="stat-value">Hold SPACE</span>
          </div>
        </div>
        {joinError && <div className="notice notice--error">Error: {joinError}</div>}
        <div className="hud-footer">
          <span className="hud-tip">Click Play again after defeat • WS endpoint ws://{wsDisplayHost}/ws</span>
        </div>
      </div>

      <div className="minimap-card">
        <canvas ref={minimapRef} className="minimap-canvas" />
        <div className="minimap-footer">
          <span>Radar</span>
          <span className="minimap-scale">Map ±{mapSize}</span>
        </div>
      </div>

      {deathInfo && !roomId && (
        <div className="overlay overlay--death">
          <div className="overlay-card">
            <span className="overlay-kicker">Game over</span>
            <h2 className="overlay-title">You were eaten!</h2>
            <p className="overlay-highlight">
              <strong>{deathInfo.score}</strong> points {deathInfo.rank ? `• Rank #${deathInfo.rank}` : null}
            </p>
            <div className="overlay-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setDeathInfo(null)
                  connectAndJoin()
                }}
              >
                Play again
              </button>
              <button className="btn btn-ghost" onClick={() => setDeathInfo(null)}>
                Change name
              </button>
            </div>
            <p className="overlay-tip">Ready when you are — hit Play again to respawn.</p>
          </div>
        </div>
      )}

      {!roomId && !deathInfo && (
        <div className="overlay overlay--start">
          <div className="overlay-card">
            <span className="overlay-kicker">Wormy 5.0</span>
            <h1 className="overlay-title">Slither to the top</h1>
            <p className="overlay-sub">Pick a nickname and jump into the arena. Boost with SPACE to outmaneuver rivals.</p>
            <label className="field">
              <span className="field-label">Nickname</span>
              <input
                className="input input--large"
                placeholder="Enter your name"
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                maxLength={20}
              />
            </label>
            {joinError && <div className="notice notice--error">Error: {joinError}</div>}
            <div className="overlay-actions">
              <button className="btn btn-primary" onClick={() => connectAndJoin()} disabled={status === 'connecting'}>
                {status === 'connecting' ? 'Connecting…' : 'Play now'}
              </button>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => setPlayerName(`Guest${Math.floor(Math.random() * 900 + 100)}`)}
              >
                Random name
              </button>
            </div>
            <p className="overlay-tip">Server: ws://{wsDisplayHost}/ws</p>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
