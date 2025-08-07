import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Snapshot = { t: 'snapshot'; roomId: string; players: { id: string; name: string; score: number; position: { x: number; y: number } }[] }
type RoomConfig = { mapSize: number; maxPlayers: number; foodCoveragePercent: number; foodSpawnRatePerSecond: number }

function useAdminRooms(apiBase: string, token: string | null) {
  const [rooms, setRooms] = useState<{ id: string; players: number; maxPlayers: number; isClosed: boolean }[]>([])
  const fetchRooms = async () => {
    if (!token) return
    const res = await fetch(`${apiBase}/admin/rooms`, { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json()
    setRooms(data.rooms || [])
  }
  useEffect(() => {
    if (!token) return
    fetchRooms()
    const id = setInterval(fetchRooms, 3000)
    return () => clearInterval(id)
  }, [apiBase, token])
  return { rooms, refetch: fetchRooms }
}

function useAdminStats(apiBase: string, token: string | null) {
  const [stats, setStats] = useState<{ totals: { players: number; rooms: number; memMB?: number }, rooms: { id: string; players: number; maxPlayers: number; isClosed: boolean; p95TickMs?: number; broadcastHz?: number }[], uptimeSec?: number } | null>(null)
  useEffect(() => {
    if (!token) return
    const fetchStats = async () => {
      const res = await fetch(`${apiBase}/admin/stats`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      setStats(data)
    }
    fetchStats()
    const id = setInterval(fetchStats, 3000)
    return () => clearInterval(id)
  }, [apiBase, token])
  return stats
}

function App() {
  const [token, setToken] = useState('dev-admin')
  const [connected, setConnected] = useState(false)
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [banName, setBanName] = useState('')
  const [mapSize, setMapSize] = useState<number>(5000)
  const [roomConfig, setRoomConfig] = useState<RoomConfig | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const apiBase = useMemo(() => `http://${location.hostname}:4000`, [])
  const { rooms, refetch } = useAdminRooms(apiBase, token)
  const stats = useAdminStats(apiBase, token)

  const connectWs = () => {
    if (!token) return
    const url = `ws://${location.hostname}:4000/admin-ws?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.onopen = () => {
      setConnected(true)
      if (selectedRoom) ws.send(JSON.stringify({ t: 'subscribe', roomId: selectedRoom }))
    }
    ws.onclose = () => setConnected(false)
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Snapshot
        if (msg.t === 'snapshot') setSnapshot(msg)
      } catch {}
    }
  }

  const openRoom = async () => {
    if (!token) return
    await fetch(`${apiBase}/admin/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    })
    refetch()
  }

  const closeRoom = async (roomId: string) => {
    if (!token) return
    await fetch(`${apiBase}/admin/rooms/${roomId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (selectedRoom === roomId) setSelectedRoom(null)
    refetch()
  }

  const kickPlayer = async (roomId: string, playerId: string) => {
    if (!token) return
    await fetch(`${apiBase}/admin/rooms/${roomId}/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ playerId })
    })
  }

  const banPlayerByName = async () => {
    if (!token || !banName.trim()) return
    await fetch(`${apiBase}/admin/ban`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: banName.trim() })
    })
    setBanName('')
  }

  useEffect(() => {
    if (connected && selectedRoom && wsRef.current) {
      wsRef.current.send(JSON.stringify({ t: 'subscribe', roomId: selectedRoom }))
    }
  }, [connected, selectedRoom])

  // Fetch room config for mapSize when selecting
  useEffect(() => {
    if (!selectedRoom || !token) return
    const fetchConfig = async () => {
      const res = await fetch(`${apiBase}/admin/rooms/${selectedRoom}/config`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data?.config) {
        setRoomConfig(data.config)
        if (typeof data.config.mapSize === 'number') setMapSize(data.config.mapSize)
      }
    }
    fetchConfig()
  }, [selectedRoom, token, apiBase])

  // Draw snapshot on canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !snapshot) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const width = canvas.width
    const height = canvas.height
    ctx.clearRect(0, 0, width, height)
    // world is [-mapSize, mapSize]
    const worldToScreen = (x: number, y: number) => {
      const nx = (x + mapSize) / (2 * mapSize)
      const ny = (y + mapSize) / (2 * mapSize)
      return { sx: nx * width, sy: (1 - ny) * height }
    }
    // draw border
    ctx.strokeStyle = '#888'
    ctx.strokeRect(0, 0, width, height)
    // draw players
    for (const p of snapshot.players) {
      const { sx, sy } = worldToScreen(p.position.x, p.position.y)
      ctx.fillStyle = '#2e86de'
      ctx.beginPath()
      ctx.arc(sx, sy, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [snapshot, mapSize])

  const Card: React.FC<{ title: string; right?: React.ReactNode; children?: React.ReactNode }> = ({ title, right, children }) => (
    <div style={{ background: '#111', border: '1px solid #222', borderRadius: 8, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{title}</h3>
        {right}
      </div>
      <div>{children}</div>
    </div>
  )

  const Grid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>{children}</div>
  )

  return (
    <>
      <h1 style={{ margin: '16px 0' }}>Admin Dashboard</h1>
      <Grid>
        <Card title="Connection">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            Token: <input value={token} onChange={(e) => setToken(e.target.value)} />
            <button onClick={connectWs} disabled={connected}>Connect WS</button>
            <button onClick={openRoom}>Open room</button>
          </div>
        </Card>
        <Card title="Global stats">
          <div>Players: {stats?.totals.players ?? '—'} | Rooms: {stats?.totals.rooms ?? '—'} | Mem: {stats?.totals.memMB ?? '—'} MB | Uptime: {stats?.uptimeSec ?? '—'} s</div>
        </Card>
        <Card title="Rooms">
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {rooms.map(r => {
              const rStats = stats?.rooms.find(x => x.id === r.id)
              return (
                <li key={r.id} style={{ marginBottom: 6 }}>
                  <button onClick={() => setSelectedRoom(r.id)} disabled={selectedRoom===r.id}>
                    {r.id.slice(0,8)} — {r.players}/{r.maxPlayers}
                  </button>
                  <button onClick={() => closeRoom(r.id)} style={{ marginLeft: 8 }}>Close</button>
                  {rStats ? (
                    <span style={{ marginLeft: 8, opacity: 0.8 }}>
                      p95: {rStats.p95TickMs}ms | bHz: {rStats.broadcastHz}
                    </span>
                  ) : null}
                </li>
              )})}
          </ul>
        </Card>
        <Card title="Ban">
          <div>
            <input placeholder="player name" value={banName} onChange={(e) => setBanName(e.target.value)} />
            <button onClick={banPlayerByName} style={{ marginLeft: 8 }}>Ban</button>
          </div>
        </Card>
        <Card title={`Snapshot ${snapshot?.roomId ? '('+snapshot.roomId.slice(0,8)+')' : ''}`}>
          <div style={{ marginBottom: 8 }}>Map size: {mapSize}</div>
          <canvas ref={canvasRef} width={400} height={300} style={{ border: '1px solid #222', background: '#000', display: 'block', marginBottom: 8, width: '100%', height: 300 }} />
          <ol style={{ maxHeight: 200, overflow: 'auto' }}>
            {snapshot?.players?.slice(0, 50).map(p => (
              <li key={p.id}>
                {p.name} — {p.score} @ ({Math.round(p.position.x)}, {Math.round(p.position.y)})
                {selectedRoom && (
                  <button onClick={() => kickPlayer(selectedRoom, p.id)} style={{ marginLeft: 8 }}>Kick</button>
                )}
              </li>
            ))}
          </ol>
        </Card>
        {selectedRoom && (
          <Card title="Room config">
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, maxWidth: 520 }}>
              <label>mapSize</label>
              <input type="number" value={roomConfig?.mapSize ?? ''} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v) && roomConfig) { setRoomConfig({ ...roomConfig, mapSize: v }); setMapSize(v) }
              }} />
              <label>maxPlayers</label>
              <input type="number" value={roomConfig?.maxPlayers ?? ''} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v) && roomConfig) setRoomConfig({ ...roomConfig, maxPlayers: v })
              }} />
              <label>foodCoveragePercent</label>
              <input type="number" value={roomConfig?.foodCoveragePercent ?? ''} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v) && roomConfig) setRoomConfig({ ...roomConfig, foodCoveragePercent: v })
              }} />
              <label>foodSpawnRatePerSecond</label>
              <input type="number" value={roomConfig?.foodSpawnRatePerSecond ?? ''} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v) && roomConfig) setRoomConfig({ ...roomConfig, foodSpawnRatePerSecond: v })
              }} />
            </div>
            <div style={{ marginTop: 8 }}>
              <button onClick={async () => {
                if (!token || !selectedRoom || !roomConfig) return
                const res = await fetch(`${apiBase}/admin/rooms/${selectedRoom}/config`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify(roomConfig)
                });
                const data = await res.json();
                if (data?.config) {
                  setRoomConfig(data.config)
                  if (typeof data.config.mapSize === 'number') setMapSize(data.config.mapSize)
                }
              }}>Save config</button>
              <button style={{ marginLeft: 8 }} onClick={async () => {
                if (!token || !selectedRoom) return
                const res = await fetch(`${apiBase}/admin/rooms/${selectedRoom}/config`, { headers: { Authorization: `Bearer ${token}` } })
                const data = await res.json();
                if (data?.config) {
                  setRoomConfig(data.config)
                  if (typeof data.config.mapSize === 'number') setMapSize(data.config.mapSize)
                }
              }}>Reload</button>
            </div>
          </Card>
        )}
      </Grid>
    </>
  )
}

export default App
