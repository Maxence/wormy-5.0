import Phaser from 'phaser'

export type Vector2 = { x: number; y: number }
export type PlayerState = { id: string; name: string; score: number; position: Vector2 }
export type FoodState = { id: string; position: Vector2; value: number }
export type MinimapFoodCell = { x: number; y: number; value: number; count: number }
export type MinimapData = { players: PlayerState[]; foods: MinimapFoodCell[] }
export type WsState = {
  t: 'state'
  roomId: string
  leaderboard: { id: string; name: string; score: number }[]
  players: PlayerState[]
  foods: FoodState[]
  selfBody?: Vector2[]
  mapSize: number
  bodyRadiusMultiplier?: number
  bodyLengthMultiplier?: number
  serverNow: number
  minimap?: MinimapData
}

function computeZoom(score: number): number {
  const z = 1 / (1 + Math.sqrt(Math.max(0, score)) * 0.03)
  return Math.min(1, Math.max(0.3, z))
}

function baseRadius(score: number): number {
  return 7 + Math.pow(Math.max(0, score), 0.6) * 0.9
}

function baseTargetLength(score: number): number {
  return 160 + score * 2.8
}

export default class GameScene extends Phaser.Scene {
  static KEY = 'GameScene'
  private playerId: string | null = null
  private latest: WsState | null = null
  private previous: WsState | null = null
  private renderDelayMs = 100
  private playerSprites: Map<string, Phaser.GameObjects.Image> = new Map()
  private playerTargets: Map<string, { x: number; y: number; score: number }> = new Map()
  private playerTrails: Map<string, Vector2[]> = new Map()
  private playerVelocity: Map<string, { vx: number; vy: number; lastUpdate: number }> = new Map()
  private foodBlitter!: Phaser.GameObjects.Blitter
  private foodBobs: Phaser.GameObjects.Bob[] = []
  private foodPoolSize = 400
  private dotTextureKey = 'dot'
  private pointerWorld: Vector2 = { x: 0, y: 0 }
  private pointerScreen: Vector2 = { x: 0, y: 0 }
  private grid!: Phaser.GameObjects.Graphics
  private trailGraphics!: Phaser.GameObjects.Graphics
  private smoothingLambda = 28 // stronger smoothing for high Hz updates
  private debugMovement = false
  private lastSnapshotLog = 0
  private lastSelfLog = 0
  private lastSmoothedPos: Vector2 | null = null
  private radiusMultiplier = 1
  private lengthMultiplier = 1
  
  // local snake reconstruction (for the local player only)
  private myPath: Vector2[] = []
  private segmentDist = 10
  private serverSelfBody: Vector2[] | null = null

  constructor() {
    super(GameScene.KEY)
    try {
      this.debugMovement = new URLSearchParams(window.location.search).has('debugMovement')
    } catch {
      this.debugMovement = false
    }
  }

  preload() {
    // generate a simple circle texture to reuse
    const g = this.add.graphics({ x: 0, y: 0 })
    g.fillStyle(0xffffff, 1)
    g.fillCircle(6, 6, 6)
    g.generateTexture(this.dotTextureKey, 12, 12)
    g.destroy()
  }

  create() {
    // food blitter for efficient many dots
    this.foodBlitter = this.add.blitter(0, 0, this.dotTextureKey)
    this.foodBlitter.setDepth(2)
    for (let i = 0; i < this.foodPoolSize; i++) {
      const bob = this.foodBlitter.create(0, 0)
      ;(bob as Phaser.GameObjects.Bob & { visible?: boolean }).visible = false
      this.foodBobs.push(bob)
    }
    this.cameras.main.setBackgroundColor('#0a0a0a')
    const startScreen = { x: this.scale.width / 2, y: this.scale.height / 2 }
    this.pointerScreen = { ...startScreen }
    const startWorld = this.cameras.main.getWorldPoint(startScreen.x, startScreen.y)
    this.pointerWorld = { x: startWorld.x, y: startWorld.y }
    this.grid = this.add.graphics()
    this.grid.setDepth(1)
    this.trailGraphics = this.add.graphics()
    this.trailGraphics.setDepth(4)
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      this.pointerScreen = { x: p.x, y: p.y }
      const wp = this.cameras.main.getWorldPoint(p.x, p.y)
      this.pointerWorld = { x: wp.x, y: wp.y }
    })
  }

  setSnapshot(s: WsState, playerId: string | null) {
    if (this.latest) {
      if (s.serverNow < this.latest.serverNow) {
        if (this.debugMovement) {
          console.warn('[wormy] dropped out-of-order snapshot', { incoming: s.serverNow, latest: this.latest.serverNow })
        }
        return
      }
      if (s.serverNow === this.latest.serverNow) {
        this.latest = s
        this.playerId = playerId
        this.serverSelfBody = s.selfBody ? s.selfBody.slice().reverse().map(pt => ({ x: pt.x, y: pt.y })) : null
        return
      }
    }
    this.previous = this.latest
    this.latest = s
    this.playerId = playerId
    this.serverSelfBody = s.selfBody ? s.selfBody.slice().reverse().map(pt => ({ x: pt.x, y: pt.y })) : null
    if (typeof s.bodyRadiusMultiplier === 'number') this.radiusMultiplier = s.bodyRadiusMultiplier
    if (typeof s.bodyLengthMultiplier === 'number') this.lengthMultiplier = s.bodyLengthMultiplier
    if (this.debugMovement && playerId) {
      const now = performance.now()
      if (now - this.lastSnapshotLog > 200) {
        const me = s.players.find(p => p.id === playerId)
        console.log('[wormy] snapshot', {
          dtFromPrev: this.previous ? s.serverNow - this.previous.serverNow : null,
          players: s.players.length,
          foods: s.foods.length,
          score: me?.score ?? null,
          position: me ? { ...me.position } : null,
          serverNow: s.serverNow,
          renderDelayMs: this.renderDelayMs
        })
        this.lastSnapshotLog = now
      }
    }
    // no immediate render; update() will interpolate at t - renderDelay
  }

  private renderNow() {
    if (!this.latest) return
    // choose interpolated snapshot between previous and latest
    let s = this.latest
    if (this.previous && this.latest.serverNow > this.previous.serverNow) {
      const targetTime = Date.now() - this.renderDelayMs
      const a = this.previous
      const b = this.latest
      const alpha = Phaser.Math.Clamp((targetTime - a.serverNow) / (b.serverNow - a.serverNow), 0, 1)
      const lerpPlayers = b.players.map(bp => {
        const ap = a.players.find(p => p.id === bp.id) || bp
        const serverDelta = Math.max(1, b.serverNow - a.serverNow)
        const vx = (bp.position.x - ap.position.x) / serverDelta
        const vy = (bp.position.y - ap.position.y) / serverDelta
        this.playerVelocity.set(bp.id, { vx, vy, lastUpdate: b.serverNow })
        return {
          ...bp,
          position: {
            x: ap.position.x + (bp.position.x - ap.position.x) * alpha,
            y: ap.position.y + (bp.position.y - ap.position.y) * alpha,
          }
        }
      })
      s = { ...b, players: lerpPlayers }
    }

    // players: set targets, create sprites if needed
    const playerIds = new Set<string>()
    for (const p of s.players) {
      let sprite = this.playerSprites.get(p.id)
      if (!sprite) {
        sprite = this.add.image(0, 0, this.dotTextureKey)
        this.playerSprites.set(p.id, sprite)
      }
      const isMe = p.id === this.playerId
      const r = this.radiusForScore(p.score)
      sprite.setVisible(true)
      sprite.setDepth(isMe ? 10 : 5)
      sprite.setTint(isMe ? 0xff5252 : 0x00aaff)
      sprite.setScale(isMe ? Math.max(r / 6, 1.2) : r / 8)
      if (!this.playerTrails.has(p.id)) this.playerTrails.set(p.id, [])
      let targetX = p.position.x
      let targetY = p.position.y
      const vel = this.playerVelocity.get(p.id)
      if (vel && this.latest) {
        const latencyMs = Date.now() - this.latest.serverNow
        const extrapolateMs = Math.min(120, Math.max(0, latencyMs + this.renderDelayMs))
        targetX = p.position.x + vel.vx * extrapolateMs
        targetY = p.position.y + vel.vy * extrapolateMs
      }
      this.playerTargets.set(p.id, { x: targetX, y: targetY, score: p.score })
      playerIds.add(p.id)
      if (this.debugMovement && p.id === this.playerId && sprite) {
        const targetDist = Phaser.Math.Distance.Between(sprite.x, sprite.y, targetX, targetY)
        if (targetDist > 220) {
          console.log('[wormy] large target delta', {
            sprite: { x: sprite.x, y: sprite.y },
            target: { x: targetX, y: targetY },
            score: p.score,
            targetDist,
            latestServerNow: this.latest?.serverNow,
            renderDelayMs: this.renderDelayMs
          })
        }
      }
    }
    // hide removed players
    for (const [id, spr] of this.playerSprites) {
      if (!playerIds.has(id)) {
        spr.destroy()
        this.playerSprites.delete(id)
        this.playerTrails.delete(id)
        this.playerVelocity.delete(id)
      }
    }

    // foods with blitter
    let idx = 0
    const cam = this.cameras.main
    const view = new Phaser.Geom.Rectangle(cam.worldView.x, cam.worldView.y, cam.worldView.width, cam.worldView.height)
    const margin = 400 / Math.max(cam.zoom, 0.01)
    view.x -= margin; view.y -= margin; view.width += margin * 2; view.height += margin * 2
    for (const f of s.foods) {
      if (idx >= this.foodBobs.length) break
      if (!view.contains(f.position.x, f.position.y)) continue
      const bob = this.foodBobs[idx++]
      bob.x = f.position.x; bob.y = f.position.y
      ;(bob as Phaser.GameObjects.Bob & { visible?: boolean }).visible = true
    }
    // hide rest
    for (; idx < this.foodBobs.length; idx++) {
      ;(this.foodBobs[idx] as Phaser.GameObjects.Bob & { visible?: boolean }).visible = false
    }

    // grid
    this.grid.clear()
    this.grid.lineStyle(1, 0x333333, 1)
    const step = 600
    const left = Math.floor((cam.worldView.x - margin) / step) * step
    const right = Math.ceil((cam.worldView.right + margin) / step) * step
    const top = Math.floor((cam.worldView.y - margin) / step) * step
    const bottom = Math.ceil((cam.worldView.bottom + margin) / step) * step
    for (let x = left; x <= right; x += step) {
      this.grid.beginPath()
      this.grid.moveTo(x, top)
      this.grid.lineTo(x, bottom)
      this.grid.strokePath()
    }
    for (let y = top; y <= bottom; y += step) {
      this.grid.beginPath()
      this.grid.moveTo(left, y)
      this.grid.lineTo(right, y)
      this.grid.strokePath()
    }

    // draw local snake body as a single stroked path (fast and smooth)
    this.trailGraphics.clear()
    const myTarget = this.playerTargets.get(this.playerId || '')
    if (this.serverSelfBody && this.serverSelfBody.length > 0) {
      this.myPath = this.serverSelfBody.slice()
    }
    if (myTarget) {
      // Use the smoothed sprite head position to avoid trail getting ahead of the head
      const spr = this.playerSprites.get(this.playerId || '')
      const head = { x: spr ? spr.x : myTarget.x, y: spr ? spr.y : myTarget.y }
      if (this.myPath.length === 0) this.myPath.push({ ...head })
      const last = this.myPath[0]
      const dx = head.x - last.x, dy = head.y - last.y
      const dist = Math.hypot(dx, dy)
      if (dist > 0) {
        const steps = Math.min(3, Math.floor(dist / this.segmentDist)) // cap per-frame insertion to avoid popping
        for (let i = 1; i <= steps; i++) {
          const t = i / Math.max(1, steps)
          this.myPath.unshift({ x: last.x + dx * t, y: last.y + dy * t })
        }
      }
      // trim total path length to target
      const targetLen = this.targetLengthForScore(myTarget.score)
      let accum = 0
      for (let i = 1; i < this.myPath.length; i++) {
        accum += Math.hypot(this.myPath[i].x - this.myPath[i - 1].x, this.myPath[i].y - this.myPath[i - 1].y)
        if (accum > targetLen) { this.myPath.length = i; break }
      }
      // decimate path to cap number of vertices (perf + stability)
      const maxVerts = 220
      let pathToDraw = this.myPath
      if (this.myPath.length > maxVerts) {
        const stride = Math.ceil(this.myPath.length / maxVerts)
        const tmp: Vector2[] = []
        for (let i = 0; i < this.myPath.length; i += stride) tmp.push(this.myPath[i])
        // ensure head is included
        if (tmp[0].x !== this.myPath[0].x || tmp[0].y !== this.myPath[0].y) tmp.unshift(this.myPath[0])
        pathToDraw = tmp
      }
      // stroke the body in one pass
      const r = this.radiusForScore(myTarget.score)
      this.trailGraphics.lineStyle(r * 1.6, 0xffaa00, 0.9)
      this.trailGraphics.beginPath()
      this.trailGraphics.moveTo(pathToDraw[0].x, pathToDraw[0].y)
      for (let i = 1; i < pathToDraw.length; i++) this.trailGraphics.lineTo(pathToDraw[i].x, pathToDraw[i].y)
      this.trailGraphics.strokePath()
      // Head disk is provided by the red head sprite (kept above by depth)
    }

    // other players trails
    for (const [id, t] of this.playerTargets) {
      if (id === this.playerId) continue
      const trail = this.playerTrails.get(id) ?? []
      const sprite = this.playerSprites.get(id)
      if (!sprite) continue
      if (trail.length === 0) trail.push({ x: sprite.x, y: sprite.y })
      const head = { x: sprite.x, y: sprite.y }
      const last = trail[0]
      const dx = head.x - last.x
      const dy = head.y - last.y
      const dist = Math.hypot(dx, dy)
      if (dist > 0.1) {
        const steps = Math.min(2, Math.floor(dist / (this.segmentDist * 0.8)))
        for (let i = 1; i <= steps; i++) {
          const mix = i / Math.max(1, steps)
          trail.unshift({ x: last.x + dx * mix, y: last.y + dy * mix })
        }
      }
      let accumulated = 0
      const target = this.targetLengthForScore(t.score) * 0.75
      for (let i = 1; i < trail.length; i++) {
        accumulated += Math.hypot(trail[i].x - trail[i - 1].x, trail[i].y - trail[i - 1].y)
        if (accumulated > target) { trail.length = i; break }
      }
      if (trail.length > 120) trail.length = 120
      this.playerTrails.set(id, trail)
      const baseColor = 0x00aaff
      const radius = this.radiusForScore(t.score) * 1.2
      this.trailGraphics.lineStyle(radius, baseColor, 0.28)
      this.trailGraphics.beginPath()
      this.trailGraphics.moveTo(head.x, head.y)
      for (let i = 0; i < trail.length; i += 4) {
        const node = trail[i]
        this.trailGraphics.lineTo(node.x, node.y)
      }
      this.trailGraphics.strokePath()
    }
  }

  getPointerWorld(): Vector2 { return this.pointerWorld }

  screenToWorld(screenX: number, screenY: number): Vector2 {
    const wp = this.cameras.main.getWorldPoint(screenX, screenY)
    return { x: wp.x, y: wp.y }
  }

  private radiusForScore(score: number): number {
    return baseRadius(score) * Math.max(0.1, this.radiusMultiplier)
  }

  private targetLengthForScore(score: number): number {
    return baseTargetLength(score) * Math.max(0.1, this.lengthMultiplier)
  }

  update(_time: number, deltaMs: number): void {
    // ensure we populate targets and visuals every frame from latest snapshot
    this.renderNow()
    const dt = Math.max(0.001, deltaMs / 1000)
    const k = 1 - Math.exp(-this.smoothingLambda * dt)
    // smooth move players toward targets
    for (const [id, spr] of this.playerSprites) {
      const t = this.playerTargets.get(id)
      if (!t) continue
      spr.x += (t.x - spr.x) * k
      spr.y += (t.y - spr.y) * k
      if (id === this.playerId) {
        this.cameras.main.centerOn(spr.x, spr.y)
        this.cameras.main.setZoom(computeZoom(t.score))
        if (this.debugMovement) {
          const now = performance.now()
          const prev = this.lastSmoothedPos
          const dist = prev ? Phaser.Math.Distance.Between(prev.x, prev.y, spr.x, spr.y) : 0
          if (dist > 160) {
            console.log('[wormy] smoothed jump', {
              from: prev,
              to: { x: spr.x, y: spr.y },
              target: { ...t },
              dist,
              renderDelayMs: this.renderDelayMs,
              latestServerNow: this.latest?.serverNow
            })
          } else if (now - this.lastSelfLog > 500) {
            console.log('[wormy] smoothed position', {
              position: { x: spr.x, y: spr.y },
              target: { ...t },
              pendingPath: this.myPath.length,
              renderDelayMs: this.renderDelayMs,
              latestServerNow: this.latest?.serverNow
            })
            this.lastSelfLog = now
          }
          this.lastSmoothedPos = { x: spr.x, y: spr.y }
        }
      }
    }
    const ps = this.pointerScreen
    if (ps) {
      const wp = this.cameras.main.getWorldPoint(ps.x, ps.y)
      this.pointerWorld = { x: wp.x, y: wp.y }
    }
  }
}
