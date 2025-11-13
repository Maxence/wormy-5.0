import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Snapshot = { t: 'snapshot'; roomId: string; players: { id: string; name: string; score: number; position: { x: number; y: number } }[] }
type RoomConfig = {
  mapSize: number
  maxPlayers: number
  foodCoveragePercent: number
  foodSpawnRatePerSecond: number
  emptyRoomTtlSeconds: number
  suctionRadiusMultiplier?: number
  suctionStrengthMultiplier?: number
  foodValueMultiplier?: number
  foodNearPlayerTarget?: number
  bodyRadiusMultiplier?: number
  bodyLengthMultiplier?: number
}

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
  const [token, setToken] = useState('')
  const [connected, setConnected] = useState(false)
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [banName, setBanName] = useState('')
  const [mapSize, setMapSize] = useState<number>(5000)
  const [defaultConfig, setDefaultConfig] = useState<RoomConfig | null>(null)
  const [defaultConfigDraft, setDefaultConfigDraft] = useState<RoomConfig | null>(null)
  const [roomConfig, setRoomConfig] = useState<RoomConfig | null>(null)
  const [roomConfigDraft, setRoomConfigDraft] = useState<RoomConfig | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [logs, setLogs] = useState<{ ts: number; type: string; roomId?: string; playerId?: string; name?: string; details?: unknown }[]>([])
  const logsRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const apiBase = useMemo(() => `http://${location.hostname}:4000`, [])
  const { rooms, refetch } = useAdminRooms(apiBase, token)
  const stats = useAdminStats(apiBase, token)
  const defaultDirty = useMemo(() => {
    if (!defaultConfigDraft || !defaultConfig) return false
    return JSON.stringify(defaultConfigDraft) !== JSON.stringify(defaultConfig)
  }, [defaultConfigDraft, defaultConfig])
  const roomDirty = useMemo(() => {
    if (!roomConfigDraft || !roomConfig) return false
    return JSON.stringify(roomConfigDraft) !== JSON.stringify(roomConfig)
  }, [roomConfigDraft, roomConfig])
  const loadDefaultConfig = useCallback(async () => {
    if (!token) return
    const res = await fetch(`${apiBase}/admin/config/default`, { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json()
    if (data?.config) {
      setDefaultConfig(data.config)
      setDefaultConfigDraft(data.config)
    }
  }, [apiBase, token])

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
        if ((msg as any).t === 'log') {
          const entry = (msg as any).entry
          setLogs((prev) => {
            const next = prev.length >= 500 ? [...prev.slice(prev.length - 499), entry] : [...prev, entry]
            return next
          })
        }
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

  // Auto-scroll logs to bottom when new entries arrive
  useEffect(() => {
    const el = logsRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [logs])

  // Fetch room config for mapSize when selecting
  useEffect(() => {
    if (!selectedRoom || !token) return
    const fetchConfig = async () => {
      const res = await fetch(`${apiBase}/admin/rooms/${selectedRoom}/config`, { headers: { Authorization: `Bearer ${token}` } })
      const data = await res.json()
      if (data?.config) {
        setRoomConfig(data.config)
        setRoomConfigDraft(data.config)
        if (typeof data.config.mapSize === 'number') setMapSize(data.config.mapSize)
      }
    }
    fetchConfig()
  }, [selectedRoom, token, apiBase])

  useEffect(() => {
    loadDefaultConfig()
  }, [loadDefaultConfig])

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
        <Card title="Default config">
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, maxWidth: 520 }}>
            <label>mapSize</label>
            <input
              type="number"
              value={defaultConfigDraft?.mapSize ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!isNaN(v)) setDefaultConfigDraft((prev) => (prev ? { ...prev, mapSize: v } : prev))
              }}
            />
            <label>maxPlayers</label>
            <input
              type="number"
              value={defaultConfigDraft?.maxPlayers ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!isNaN(v)) setDefaultConfigDraft((prev) => (prev ? { ...prev, maxPlayers: v } : prev))
              }}
            />
            <label>foodCoveragePercent</label>
            <input
              type="number"
              value={defaultConfigDraft?.foodCoveragePercent ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!isNaN(v)) setDefaultConfigDraft((prev) => (prev ? { ...prev, foodCoveragePercent: v } : prev))
              }}
            />
            <label>foodSpawnRatePerSecond</label>
            <input
              type="number"
              value={defaultConfigDraft?.foodSpawnRatePerSecond ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!isNaN(v)) setDefaultConfigDraft((prev) => (prev ? { ...prev, foodSpawnRatePerSecond: v } : prev))
              }}
            />
            <label>emptyRoomTtlSeconds</label>
            <input
              type="number"
              value={defaultConfigDraft?.emptyRoomTtlSeconds ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!isNaN(v)) setDefaultConfigDraft((prev) => (prev ? { ...prev, emptyRoomTtlSeconds: v } : prev))
              }}
            />
            <label>foodValueMultiplier</label>
            <input
              type="number"
              step="0.1"
              value={defaultConfigDraft?.foodValueMultiplier ?? 1}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!isNaN(v)) setDefaultConfigDraft((prev) => (prev ? { ...prev, foodValueMultiplier: v } : prev))
              }}
            />
            <label>foodNearPlayerTarget</label>
            <input
              type="number"
              value={defaultConfigDraft?.foodNearPlayerTarget ?? 80}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!isNaN(v)) setDefaultConfigDraft((prev) => (prev ? { ...prev, foodNearPlayerTarget: v } : prev))
              }}
            />
            <label>suctionStrengthMultiplier</label>
            <input
              type="number"
              step="0.1"
              value={defaultConfigDraft?.suctionStrengthMultiplier ?? ''}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!isNaN(v)) setDefaultConfigDraft((prev) => (prev ? { ...prev, suctionStrengthMultiplier: v } : prev))
              }}
            />
            <label>bodyRadiusMultiplier</label>
            <input
              type="number"
              step="0.1"
              value={defaultConfigDraft?.bodyRadiusMultiplier ?? 1}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!isNaN(v)) setDefaultConfigDraft((prev) => (prev ? { ...prev, bodyRadiusMultiplier: v } : prev))
              }}
            />
            <label>bodyLengthMultiplier</label>
            <input
              type="number"
              step="0.1"
              value={defaultConfigDraft?.bodyLengthMultiplier ?? 1}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!isNaN(v)) setDefaultConfigDraft((prev) => (prev ? { ...prev, bodyLengthMultiplier: v } : prev))
              }}
            />
          </div>
          <div style={{ marginTop: 8 }}>
            <button
              onClick={async () => {
                if (!token || !defaultConfigDraft) return
                const res = await fetch(`${apiBase}/admin/config/default`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify(defaultConfigDraft)
                })
                const data = await res.json()
                if (data?.config) {
                  setDefaultConfig(data.config)
                  setDefaultConfigDraft(data.config)
                }
              }}
              disabled={!defaultConfigDraft || !defaultDirty}
            >
              Save default
            </button>
            <button style={{ marginLeft: 8 }} onClick={() => { loadDefaultConfig() }}>Reload</button>
          </div>
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>Note: set emptyRoomTtlSeconds to 0 to keep empty rooms alive indefinitely.</div>
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
        <Card title="Live logs">
          <div ref={logsRef} style={{ maxHeight: 260, overflow: 'auto', fontFamily: 'monospace', fontSize: 12 }}>
            {logs.map((l, i) => (
              <div key={i}>
                [{new Date(l.ts).toLocaleTimeString()}] {l.type} {l.roomId ? `room=${l.roomId.slice(0,8)}` : ''} {l.playerId ? `player=${l.playerId.slice(0,8)}` : ''} {l.name ? `name=${l.name}` : ''}
              </div>
            ))}
          </div>
        </Card>
        {selectedRoom && (
          <Card title="Room config">
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8, maxWidth: 520 }}>
              <label>mapSize</label>
              <input type="number" value={roomConfigDraft?.mapSize ?? ''} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v)) { setRoomConfigDraft((prev) => prev ? { ...prev, mapSize: v } : prev); setMapSize(v) }
              }} />
              <label>maxPlayers</label>
              <input type="number" value={roomConfigDraft?.maxPlayers ?? ''} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v)) setRoomConfigDraft((prev) => prev ? { ...prev, maxPlayers: v } : prev)
              }} />
              <label>foodCoveragePercent</label>
              <input type="number" value={roomConfigDraft?.foodCoveragePercent ?? ''} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v)) setRoomConfigDraft((prev) => prev ? { ...prev, foodCoveragePercent: v } : prev)
              }} />
              <label>foodSpawnRatePerSecond</label>
              <input type="number" value={roomConfigDraft?.foodSpawnRatePerSecond ?? ''} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v)) setRoomConfigDraft((prev) => prev ? { ...prev, foodSpawnRatePerSecond: v } : prev)
              }} />
              <label>emptyRoomTtlSeconds</label>
              <input type="number" value={roomConfigDraft?.emptyRoomTtlSeconds ?? ''} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v)) setRoomConfigDraft((prev) => prev ? { ...prev, emptyRoomTtlSeconds: v } : prev)
              }} />
              <label>foodValueMultiplier</label>
              <input type="number" step="0.1" value={roomConfigDraft?.foodValueMultiplier ?? 1} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v)) setRoomConfigDraft((prev) => prev ? { ...prev, foodValueMultiplier: v } : prev)
              }} />
              <label>foodNearPlayerTarget</label>
              <input type="number" value={roomConfigDraft?.foodNearPlayerTarget ?? 80} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v)) setRoomConfigDraft((prev) => prev ? { ...prev, foodNearPlayerTarget: v } : prev)
              }} />
              <label>suctionStrengthMultiplier</label>
              <input type="number" step="0.1" value={roomConfigDraft?.suctionStrengthMultiplier ?? ''} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v)) setRoomConfigDraft((prev) => prev ? { ...prev, suctionStrengthMultiplier: v } : prev)
              }} />
              <label>bodyRadiusMultiplier</label>
              <input type="number" step="0.1" value={roomConfigDraft?.bodyRadiusMultiplier ?? 1} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v)) setRoomConfigDraft((prev) => prev ? { ...prev, bodyRadiusMultiplier: v } : prev)
              }} />
              <label>bodyLengthMultiplier</label>
              <input type="number" step="0.1" value={roomConfigDraft?.bodyLengthMultiplier ?? 1} onChange={(e) => {
                const v = Number(e.target.value); if (!isNaN(v)) setRoomConfigDraft((prev) => prev ? { ...prev, bodyLengthMultiplier: v } : prev)
              }} />
            </div>
            <div style={{ marginTop: 8 }}>
              <button onClick={async () => {
                if (!token || !selectedRoom || !roomConfigDraft) return
                const res = await fetch(`${apiBase}/admin/rooms/${selectedRoom}/config`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                  body: JSON.stringify(roomConfigDraft)
                });
                const data = await res.json();
                if (data?.config) {
                  setRoomConfig(data.config)
                  setRoomConfigDraft(data.config)
                  if (typeof data.config.mapSize === 'number') setMapSize(data.config.mapSize)
                }
              }} disabled={!roomConfigDraft || !roomDirty}>Save config</button>
              <button style={{ marginLeft: 8 }} onClick={async () => {
                if (!token || !selectedRoom) return
                const res = await fetch(`${apiBase}/admin/rooms/${selectedRoom}/config`, { headers: { Authorization: `Bearer ${token}` } })
                const data = await res.json();
                if (data?.config) {
                  setRoomConfig(data.config)
                  setRoomConfigDraft(data.config)
                  if (typeof data.config.mapSize === 'number') setMapSize(data.config.mapSize)
                }
              }}>Reload</button>
            </div>
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>Note: 0 disables the empty-room auto close.</div>
          </Card>
        )}
      </Grid>
    </>
  )
}

export default App
