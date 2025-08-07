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
  | { t: 'dead' }
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
  const [joinError, setJoinError] = useState<string | null>(null)
  const lastPings = useRef<Map<number, number>>(new Map())
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const minimapRef = useRef<HTMLCanvasElement | null>(null)
  const mousePos = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const playerHistories = useRef<Map<string, Vector2[]>>(new Map())
  type Particle = { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number; color: string }
  const particlesRef = useRef<Particle[]>([])

  const radiusFromScore = (score: number) => Math.max(4, 6 + Math.sqrt(Math.max(0, score)) * 0.3)
  const hashHue = (id: string) => {
    let h = 0
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
    return h % 360
  }

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
      setStatus('disconnected')
      // rotate url for next connect attempt
      urlIndexRef.current = (urlIndexRef.current + 1) % wsUrlCandidates.length
      // auto-retry after short delay if not joined
      if (!roomId) {
        setTimeout(() => {
          if (wsRef.current === ws && status !== 'connected') connectAndJoin()
        }, 1500)
      }
    }
    ws.onerror = (e) => {
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
          const my = players.find(p => p.id === playerId)
          if (my) {
            for (let i = 0; i < 60; i++) {
              const a = Math.random() * Math.PI * 2
              const sp = 40 + Math.random() * 140
              particlesRef.current.push({
                x: my.position.x, y: my.position.y,
                vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                life: 0, maxLife: 0.7 + Math.random() * 0.6,
                size: 2 + Math.random() * 3,
                color: 'rgba(241,196,15,1)'
              })
            }
          }
        } else if (msg.t === 'state') {
          prevSnapshotRef.current = currSnapshotRef.current
          currSnapshotRef.current = msg
          setLeaderboard(msg.leaderboard)
          setPlayers(msg.players)
          setFoods(msg.foods)
          setMapSize(msg.mapSize)
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
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ t: 'input', playerId, directionRad: angle, boosting }))
      }
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

  useEffect(() => {
    let raf = 0
    let lastTs = performance.now()
    let fpsAcc = 0; let fpsCount = 0; let fpsDisplay = 0
    const draw = () => {
      const nowTs = performance.now()
      const dt = Math.min(0.05, Math.max(0.0, (nowTs - lastTs) / 1000))
      lastTs = nowTs
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

      const camX = my?.position.x ?? 0
      const camY = my?.position.y ?? 0
      const worldToScreen = (x: number, y: number) => {
        const sx = (x - camX) * zoom + width / 2
        const sy = (y - camY) * zoom + height / 2
        return { sx, sy }
      }

      // Background grid (after cam computed)
      ctx.fillStyle = '#0a0a0a'
      ctx.fillRect(0, 0, width, height)
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 1
      const grid = 100 * zoom
      ctx.beginPath()
      for (let x = (width/2 - ((camX * zoom) % grid)); x < width; x += grid) {
        ctx.moveTo(x, 0); ctx.lineTo(x, height)
      }
      for (let y = (height/2 - ((camY * zoom) % grid)); y < height; y += grid) {
        ctx.moveTo(0, y); ctx.lineTo(width, y)
      }
      ctx.stroke()

      // Food glow
      for (const f of foods) {
        const { sx, sy } = worldToScreen(f.position.x, f.position.y)
        const r = Math.max(1.5, 2.5 * zoom)
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 3)
        g.addColorStop(0, 'rgba(46, 204, 113, 0.9)')
        g.addColorStop(1, 'rgba(46, 204, 113, 0)')
        ctx.fillStyle = g
        ctx.beginPath(); ctx.arc(sx, sy, r * 3, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = '#2ecc71'
        ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill()
      }

      // Update histories and particles, then draw trails and heads
      const histories = playerHistories.current
      for (const p of renderPlayers) {
        const hist = histories.get(p.id) ?? []
        hist.push({ x: p.position.x, y: p.position.y })
        // Limit trail length (shorter for others)
        const targetLen = p.id === playerId ? Math.min(180, 60 + Math.floor(p.score * 0.6)) : 18
        if (hist.length > targetLen) hist.splice(0, hist.length - targetLen)
        histories.set(p.id, hist)
      }

      // Spawn boost particles for my player
      if (my) {
        const myHist = playerHistories.current.get(my.id) || []
        const n = myHist.length
        if (n >= 2 && boosting) {
          const prev = myHist[n - 2]
          const curr = myHist[n - 1]
          const dx = curr.x - prev.x, dy = curr.y - prev.y
          const dir = Math.atan2(dy, dx)
          for (let i = 0; i < 2; i++) {
            const sp = 40 + Math.random() * 60
            particlesRef.current.push({
              x: curr.x, y: curr.y,
              vx: Math.cos(dir + Math.PI + (Math.random()-0.5)*0.5) * sp,
              vy: Math.sin(dir + Math.PI + (Math.random()-0.5)*0.5) * sp,
              life: 0, maxLife: 0.4 + Math.random() * 0.3,
              size: 2 + Math.random() * 2,
              color: 'rgba(241,196,15,1)'
            })
          }
        }
      }

      // Draw trails
      for (const p of renderPlayers) {
        const hist = playerHistories.current.get(p.id) || []
        if (hist.length < 2) continue
        const baseR = radiusFromScore(p.score) * zoom
        const hue = hashHue(p.id)
        for (let i = 1; i < hist.length; i++) {
          const t = i / hist.length
          const pt = hist[i]
          const { sx, sy } = worldToScreen(pt.x, pt.y)
          const r = baseR * (0.4 + 0.6 * t)
          ctx.fillStyle = p.id === playerId ? `hsl(48 90% ${50 + 30*t}% / 0.9)` : `hsl(${hue} 80% ${45 + 25*t}% / 0.85)`
          ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill()
        }
      }

      // Draw heads with gradient outline
      for (const p of renderPlayers) {
        const { sx, sy } = worldToScreen(p.position.x, p.position.y)
        const r = radiusFromScore(p.score) * zoom
        const hue = hashHue(p.id)
        const g = ctx.createRadialGradient(sx, sy, r*0.2, sx, sy, r)
        if (p.id === playerId) { g.addColorStop(0, '#ffe680'); g.addColorStop(1, '#f1c40f') }
        else { g.addColorStop(0, `hsl(${hue} 100% 60%)`); g.addColorStop(1, `hsl(${hue} 80% 45%)`) }
        ctx.fillStyle = g
        ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.15)'
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(sx, sy, r+1, 0, Math.PI * 2); ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.font = `${Math.max(10, 12 * zoom)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(p.name, sx, sy - r - 6)
      }

      // Update and draw particles
      const parts = particlesRef.current
      for (let i = parts.length - 1; i >= 0; i--) {
        const pa = parts[i]
        pa.life += dt
        if (pa.life >= pa.maxLife) { parts.splice(i, 1); continue }
        // integrate
        pa.x += pa.vx * dt
        pa.y += pa.vy * dt
        pa.vx *= 0.98
        pa.vy *= 0.98
        const { sx, sy } = worldToScreen(pa.x, pa.y)
        const alpha = 1 - (pa.life / pa.maxLife)
        ctx.fillStyle = pa.color.replace(',1)', `,${alpha.toFixed(2)})`)
        ctx.beginPath(); ctx.arc(sx, sy, pa.size * zoom, 0, Math.PI * 2); ctx.fill()
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
      // fps
      fpsAcc += 1/dt; fpsCount++
      if (fpsCount >= 10) { fpsDisplay = Math.round(fpsAcc / fpsCount); fpsAcc = 0; fpsCount = 0 }
      ctx.fillText(`FPS: ${fpsDisplay}`, 20, y)

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
          // border
          mctx.strokeStyle = '#444'
          mctx.strokeRect(0.5, 0.5, mini.width-1, mini.height-1)
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
