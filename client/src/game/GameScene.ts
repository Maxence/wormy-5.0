import Phaser from 'phaser'

export type Vector2 = { x: number; y: number }
export type PlayerState = { id: string; name: string; score: number; position: Vector2 }
export type FoodState = { id: string; position: Vector2; value: number }
export type WsState = { t: 'state'; roomId: string; leaderboard: { id: string; name: string; score: number }[]; players: PlayerState[]; foods: FoodState[]; selfBody?: Vector2[]; mapSize: number; serverNow: number }

function computeZoom(score: number): number {
  const z = 1 / (1 + Math.sqrt(Math.max(0, score)) * 0.03)
  return Math.min(1, Math.max(0.3, z))
}

export default class GameScene extends Phaser.Scene {
  static KEY = 'GameScene'
  private playerId: string | null = null
  private latest: WsState | null = null
  private previous: WsState | null = null
  private renderDelayMs = 100
  private lastRenderTime = 0
  private playerSprites: Map<string, Phaser.GameObjects.Image> = new Map()
  private playerTargets: Map<string, { x: number; y: number; score: number }> = new Map()
  private foodBlitter!: Phaser.GameObjects.Blitter
  private foodBobs: Phaser.GameObjects.Bob[] = []
  private foodPoolSize = 400
  private dotTextureKey = 'dot'
  private pointerWorld: Vector2 = { x: 0, y: 0 }
  private grid!: Phaser.GameObjects.Graphics
  private trailGraphics!: Phaser.GameObjects.Graphics
  private smoothingLambda = 28 // stronger smoothing for high Hz updates

  constructor() {
    super(GameScene.KEY)
  }

  preload() {
    // generate a simple circle texture to reuse
    const g = this.make.graphics({ x: 0, y: 0, add: false })
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
      // @ts-expect-error - bob.visible exists
      ;(bob as any).visible = false
      this.foodBobs.push(bob)
    }
    this.cameras.main.setBackgroundColor('#0a0a0a')
    this.grid = this.add.graphics({ depth: 1 })
    this.trailGraphics = this.add.graphics({ depth: 4 })
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      const wp = this.cameras.main.getWorldPoint(p.x, p.y)
      this.pointerWorld = { x: wp.x, y: wp.y }
    })
  }

  setSnapshot(s: WsState, playerId: string | null) {
    this.previous = this.latest
    this.latest = s
    this.playerId = playerId
    // no immediate render; update() will interpolate at t - renderDelay
  }

  private renderNow() {
    if (!this.latest) return
    const now = performance.now()
    this.lastRenderTime = now
    // choose interpolated snapshot between previous and latest
    let s = this.latest
    if (this.previous && this.latest.serverNow > this.previous.serverNow) {
      const targetTime = Date.now() - this.renderDelayMs
      const a = this.previous
      const b = this.latest
      const alpha = Phaser.Math.Clamp((targetTime - a.serverNow) / (b.serverNow - a.serverNow), 0, 1)
      const lerpPlayers = b.players.map(bp => {
        const ap = a.players.find(p => p.id === bp.id) || bp
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
      const r = Math.max(6, 6 + Math.sqrt(Math.max(0, p.score)) * 0.3)
      sprite.setVisible(true)
      sprite.setDepth(isMe ? 10 : 5)
      sprite.setTint(isMe ? 0xff5252 : 0x00aaff)
      sprite.setScale(isMe ? Math.max(r / 6, 1.2) : r / 8)
      this.playerTargets.set(p.id, { x: p.position.x, y: p.position.y, score: p.score })
      playerIds.add(p.id)
    }
    // hide removed players
    for (const [id, spr] of this.playerSprites) {
      if (!playerIds.has(id)) {
        spr.destroy()
        this.playerSprites.delete(id)
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
      // @ts-expect-error
      ;(bob as any).visible = true
    }
    // hide rest
    for (; idx < this.foodBobs.length; idx++) {
      // @ts-expect-error
      ;(this.foodBobs[idx] as any).visible = false
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

    // draw self trail if provided
    this.trailGraphics.clear()
    if (s.selfBody && s.selfBody.length > 2) {
      this.trailGraphics.lineStyle(6, 0xffaa00, 0.4)
      for (let i = 1; i < s.selfBody.length; i++) {
        const a = s.selfBody[i - 1]
        const b = s.selfBody[i]
        this.trailGraphics.beginPath()
        this.trailGraphics.moveTo(a.x, a.y)
        this.trailGraphics.lineTo(b.x, b.y)
        this.trailGraphics.strokePath()
      }
    }
  }

  getPointerWorld(): Vector2 { return this.pointerWorld }

  update(time: number, deltaMs: number): void {
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
      }
    }
  }
}


