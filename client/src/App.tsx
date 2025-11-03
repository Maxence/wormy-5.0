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
  serverNow: number
  minimap?: { players: MinimapPlayer[]; foods: MinimapFoodCell[] }
}
type WsMessage =
  | { t: 'welcome' }
  | { t: 'ping'; pingId: number }
  | { t: 'pong'; now?: number; pingId?: number | null }
  | { t: 'latency'; rttMs: number }
  | { t: 'joined'; roomId: string; playerId: string }
  | { t: 'dead' }
  | WsState

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

  const wsUrlCandidates = useMemo(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const hosts = ['127.0.0.1', 'localhost', location.hostname]
    const port = 4000
    return hosts.map(h => `${proto}://${h}:${port}/ws`)
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
    const url = wsUrlCandidates[urlIndexRef.current % wsUrlCandidates.length]
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
      setJoinError('WS_CONNECT_FAILED')
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
        } else if ((msg as any).t === 'error') {
          const anyMsg = msg as any
          setJoinError(anyMsg.error || 'JOIN_FAILED')
        } else if (msg.t === 'dead') {
          const snap = currSnapshotRef.current
          const me = snap?.players.find(p => p.id === playerId)
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
          // show a brief banner or change status if needed
          setStatus('disconnected')
          setRoomId(null)
          setPlayerId(null)
          setMinimapPlayers([])
          setMinimapFoods([])
          prevSnapshotRef.current = null
          currSnapshotRef.current = null
          setBoosting(false)
        } else if (msg.t === 'state') {
          prevSnapshotRef.current = currSnapshotRef.current
          currSnapshotRef.current = msg
          setLeaderboard(msg.leaderboard)
          setMinimapPlayers(msg.minimap?.players ?? [])
          setMinimapFoods(msg.minimap?.foods ?? [])
          setMapSize(msg.mapSize)
          const scene = phaserSceneRef.current
          if (scene) scene.setSnapshot(msg as unknown as SceneWsState, playerId)
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
    statusRef.current = status
  }, [status])

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
      const scene = phaserSceneRef.current
      const ptr = scene ? ((scene as any).getPointerWorld() as { x: number; y: number }) : null
      const snap = currSnapshotRef.current
      let angle = 0
      if (ptr && snap) {
        const me = snap.players.find(p => p.id === playerId)
        if (me) angle = Math.atan2(ptr.y - me.position.y, ptr.x - me.position.x)
      }
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ t: 'input', playerId, directionRad: angle, boosting }))
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
      return { x: nx * mini.width, y: (1 - ny) * mini.height }
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
    ctx.strokeStyle = '#444'
    ctx.strokeRect(0.5, 0.5, mini.width - 1, mini.height - 1)
  }, [minimapPlayers, minimapFoods, mapSize, playerId])

  return (
    <>
      <div ref={phaserContainerRef} style={{ position: 'fixed', inset: 0 }} />
      <div style={{ position: 'fixed', top: 8, right: 8, background: 'rgba(0,0,0,0.6)', padding: 10, color: '#fff', borderRadius: 8, minWidth: 240 }}>
        <div>Player: <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} /></div>
        <div>Room: {roomId ?? '—'}</div>
        <div>Player ID: {playerId ?? '—'}</div>
        <div>Boost: hold Space</div>
        <div>Status: {status}</div>
        <div>RTT: {rttMs ?? '—'} ms</div>
        <div>FPS: {fps ?? '—'}</div>
        {joinError && <div style={{ color: '#ff7675' }}>Error: {joinError}</div>}
      </div>
      <canvas ref={minimapRef} style={{ position: 'fixed', right: 12, bottom: 12, width: 200, height: 200, border: '1px solid #333' }} />
      {!roomId && (
        <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <div style={{ background: 'rgba(0,0,0,0.6)', color: '#fff', padding: 20, borderRadius: 8, minWidth: 320, pointerEvents: 'auto' }}>
            <h2 style={{ marginTop: 0 }}>Start a game</h2>
            <div style={{ display: 'grid', gap: 10 }}>
              <label>
                Name
                <input style={{ width: '100%' }} value={playerName} onChange={(e) => setPlayerName(e.target.value)} />
              </label>
              {joinError && <div style={{ color: '#ff7675' }}>Error: {joinError}</div>}
              <button onClick={() => { connectAndJoin() }} disabled={status === 'connecting'}>
                Play
        </button>
              <div style={{ opacity: 0.8, fontSize: 12 }}>Status: {status} • Server ws://{location.hostname}:4000/ws</div>
            </div>
          </div>
      </div>
      )}
    </>
  )
}

export default App
