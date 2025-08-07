import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Snapshot = { t: 'snapshot'; roomId: string; players: { id: string; name: string; score: number; position: { x: number; y: number } }[] }

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

function App() {
  const [token, setToken] = useState('dev-admin')
  const [connected, setConnected] = useState(false)
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [banName, setBanName] = useState('')
  const wsRef = useRef<WebSocket | null>(null)

  const apiBase = useMemo(() => `http://${location.hostname}:4000`, [])
  const { rooms, refetch } = useAdminRooms(apiBase, token)

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

  return (
    <>
      <h1>Admin Spectator</h1>
      <div style={{ display: 'flex', gap: 16 }}>
        <div>
          <p>Token: <input value={token} onChange={(e) => setToken(e.target.value)} /></p>
          <button onClick={connectWs} disabled={connected}>Connect WS</button>
          <button onClick={openRoom} style={{ marginLeft: 8 }}>Open room</button>
          <h2>Rooms</h2>
          <ul>
            {rooms.map(r => (
              <li key={r.id}>
                <button onClick={() => setSelectedRoom(r.id)} disabled={selectedRoom===r.id}>
                  {r.id.slice(0,8)} — {r.players}/{r.maxPlayers}
                </button>
                <button onClick={() => closeRoom(r.id)} style={{ marginLeft: 8 }}>
                  Close
                </button>
              </li>
            ))}
          </ul>
          <div>
            <h3>Ban</h3>
            <input placeholder="player name" value={banName} onChange={(e) => setBanName(e.target.value)} />
            <button onClick={banPlayerByName} style={{ marginLeft: 8 }}>Ban</button>
          </div>
        </div>
        <div>
          <h2>Snapshot {snapshot?.roomId ? `(${snapshot.roomId.slice(0,8)})` : ''}</h2>
          <ol>
            {snapshot?.players?.slice(0, 50).map(p => (
              <li key={p.id}>
                {p.name} — {p.score} @ ({Math.round(p.position.x)}, {Math.round(p.position.y)})
                {selectedRoom && (
                  <button onClick={() => kickPlayer(selectedRoom, p.id)} style={{ marginLeft: 8 }}>Kick</button>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </>
  )
}

export default App
