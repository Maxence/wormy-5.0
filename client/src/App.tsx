import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type WsMessage =
  | { t: 'welcome' }
  | { t: 'ping'; pingId: number }
  | { t: 'pong'; now?: number; pingId?: number | null }
  | { t: 'latency'; rttMs: number }
  | { t: string; [k: string]: unknown }

function App() {
  const [rttMs, setRttMs] = useState<number | null>(null)
  const [status, setStatus] = useState<'disconnected'|'connecting'|'connected'>('disconnected')
  const [playerName, setPlayerName] = useState('Player')
  const [roomId, setRoomId] = useState<string | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const lastPings = useRef<Map<number, number>>(new Map())

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
        } else if ((msg as any).t === 'joined') {
          const anyMsg = msg as any
          setRoomId(anyMsg.roomId)
          setPlayerId(anyMsg.playerId)
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
  }, [wsUrl])

  return (
    <>
      <h1>Wormy Client</h1>
      <p>Status: {status}</p>
      <p>
        Player: <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} />
      </p>
      <p>Room: {roomId ?? '—'}</p>
      <p>Player ID: {playerId ?? '—'}</p>
      <p>Latency (RTT): {rttMs ?? '—'} ms</p>
    </>
  )
}

export default App
