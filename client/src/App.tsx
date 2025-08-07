import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Vector2 = { x: number; y: number }
type PlayerState = { id: string; name: string; score: number; position: Vector2 }
type FoodState = { id: string; position: Vector2; value: number }
type WsState = { t: 'state'; roomId: string; leaderboard: { id: string; name: string; score: number }[]; players: PlayerState[]; foods: FoodState[]; mapSize: number; serverNow: number }
type WsMessage =
  | { t: 'welcome' }
  | { t: 'ping'; pingId: number }
  | { t: 'pong'; now?: number; pingId?: number | null }
  | { t: 'latency'; rttMs: number }
  | { t: 'joined'; roomId: string; playerId: string }
  | WsState
  | { t: string; [k: string]: unknown }

function computeZoom(score: number): number {
  const z = 1 / (1 + Math.sqrt(Math.max(0, score)) * 0.03)
  return Math.min(1, Math.max(0.3, z))
}

function App() {
  const [rttMs, setRttMs] = useState<number | null>(null)
  const [status, setStatus] = useState<'disconnected'|'connecting'|'connected'>('disconnected')
  const [playerName, setPlayerName] = useState('Player')
  const [roomId, setRoomId] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [leaderboard, setLeaderboard] = useState<{ id: string; name: string; score: number }[]>([])
  const [players, setPlayers] = useState<PlayerState[]>([])
  const [foods, setFoods] = useState<FoodState[]>([])
  const [mapSize, setMapSize] = useState<number>(5000)
  const prevSnapshotRef = useRef<WsState | null>(null)
  const currSnapshotRef = useRef<WsState | null>(null)
  const [boosting, setBoosting] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const lastPings = useRef<Map<number, number>>(new Map())
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const minimapRef = useRef<HTMLCanvasElement | null>(null)
  const mousePos = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const wsUrl = useMemo(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const host = location.hostname
    const port = 4000
    return `${proto}://${host}:${port}/ws`
  }, [])

  useEffect(() => {
    setStatus('connecting')
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws
    ws.onopen = () => {
      setStatus('connected')
      ws.send(JSON.stringify({ t: 'hello', name: playerName }))
    }
    ws.onclose = () => setStatus('disconnected')
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
        } else if (msg.t === 'state') {
          // snapshots for interpolation
          prevSnapshotRef.current = currSnapshotRef.current
          currSnapshotRef.current = msg
          setLeaderboard(msg.leaderboard)
          setPlayers(msg.players)
          setFoods(msg.foods)
          setMapSize(msg.mapSize)
        }
      } catch {
      }
    }
    const id = setInterval(() => {
      const pingId = Date.now()
      lastPings.current.set(pingId, Date.now())
      ws.send(JSON.stringify({ t: 'ping', pingId }))
    }, 5000)
    return () => {
      clearInterval(id)
      ws.close()
    }
  }, [wsUrl, playerName])

  useEffect(() => {
    const onMove = (e: MouseEvent) => { mousePos.current = { x: e.clientX, y: e.clientY } }
    const onDown = (e: KeyboardEvent) => { if (e.code === 'Space') setBoosting(true) }
    const onUp = (e: KeyboardEvent) => { if (e.code === 'Space') setBoosting(false) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => {
      if (!wsRef.current || !playerId) return
      const canvas = canvasRef.current
      if (!canvas) return
      const centerX = canvas.width / 2
      const centerY = canvas.height / 2
      const angle = Math.atan2(mousePos.current.y - centerY, mousePos.current.x - centerX)
      wsRef.current.send(JSON.stringify({ t: 'input', playerId, directionRad: angle, boosting }))
    }, 50)
    return () => clearInterval(id)
  }, [playerId, boosting])

  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      const mini = minimapRef.current
      if (mini) { mini.width = 200; mini.height = 200 }
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    let raf = 0
    const draw = () => {
      const canvas = canvasRef.current
      if (!canvas) { raf = requestAnimationFrame(draw); return }
      const ctx = canvas.getContext('2d')
      if (!ctx) { raf = requestAnimationFrame(draw); return }
      // Interpolate players between snapshots
      const prev = prevSnapshotRef.current
      const curr = currSnapshotRef.current
      let renderPlayers: PlayerState[] = players
      const interpolationDelayMs = 100
      if (prev && curr && curr.serverNow > prev.serverNow) {
        const renderTime = Date.now() - interpolationDelayMs
        const alpha = Math.max(0, Math.min(1, (renderTime - prev.serverNow) / (curr.serverNow - prev.serverNow)))
        const prevById = new Map(prev.players.map(p => [p.id, p]))
        renderPlayers = curr.players.map(cp => {
          const pp = prevById.get(cp.id)
          if (!pp) return cp
          return {
            ...cp,
            position: {
              x: pp.position.x + (cp.position.x - pp.position.x) * alpha,
              y: pp.position.y + (cp.position.y - pp.position.y) * alpha,
            }
          }
        })
      }

      const my = renderPlayers.find(p => p.id === playerId)
      const score = my?.score ?? 10
      const zoom = computeZoom(score)
      const width = canvas.width
      const height = canvas.height

      ctx.fillStyle = '#0a0a0a'
      ctx.fillRect(0, 0, width, height)

      const camX = my?.position.x ?? 0
      const camY = my?.position.y ?? 0
      const worldToScreen = (x: number, y: number) => {
        const sx = (x - camX) * zoom + width / 2
        const sy = (y - camY) * zoom + height / 2
        return { sx, sy }
      }

      ctx.fillStyle = '#2ecc71'
      for (const f of foods) {
        const { sx, sy } = worldToScreen(f.position.x, f.position.y)
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(1, 2 * zoom), 0, Math.PI * 2); ctx.fill()
      }

      for (const p of renderPlayers) {
        const { sx, sy } = worldToScreen(p.position.x, p.position.y)
        const r = Math.max(3, 6 + Math.sqrt(Math.max(0, p.score)) * 0.3) * zoom
        ctx.fillStyle = p.id === playerId ? '#f1c40f' : '#3498db'
        ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = `${Math.max(10, 12 * zoom)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(p.name, sx, sy - r - 6)
      }

      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(12, 12, 220, 160)
      ctx.fillStyle = '#fff'
      ctx.font = '14px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(`Status: ${status}`, 20, 36)
      ctx.fillText(`RTT: ${rttMs ?? '—'} ms`, 20, 56)
      ctx.fillText(`Score: ${my?.score ?? 0}`, 20, 76)
      ctx.fillText('Top 10:', 20, 98)
      let y = 118
      for (const e of leaderboard.slice(0, 10)) {
        ctx.fillText(`${e.name} — ${e.score}`, 20, y)
        y += 18
      }

      const mini = minimapRef.current
      if (mini) {
        const mctx = mini.getContext('2d')
        if (mctx) {
          mctx.fillStyle = '#111'; mctx.fillRect(0, 0, mini.width, mini.height)
          const ms = mapSize || 5000
          const toMini = (x: number, y: number) => {
            const nx = (x + ms) / (2 * ms)
            const ny = (y + ms) / (2 * ms)
            return { x: nx * mini.width, y: (1 - ny) * mini.height }
          }
          for (const p of renderPlayers) {
            const pos = toMini(p.position.x, p.position.y)
            mctx.fillStyle = p.id === playerId ? '#f1c40f' : '#3498db'
            mctx.fillRect(pos.x - 2, pos.y - 2, 4, 4)
          }
        }
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [players, foods, leaderboard, playerId, status, rttMs, mapSize])

  return (
    <>
      <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0 }} />
      <div style={{ position: 'fixed', top: 8, right: 8, background: 'rgba(0,0,0,0.5)', padding: 8, color: '#fff', borderRadius: 6 }}>
        <div>Player: <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} /></div>
        <div>Room: {roomId ?? '—'}</div>
        <div>Player ID: {playerId ?? '—'}</div>
        <div>Boost: hold Space</div>
      </div>
      <canvas ref={minimapRef} style={{ position: 'fixed', right: 12, bottom: 12, width: 200, height: 200, border: '1px solid #333' }} />
    </>
  )
}

export default App
