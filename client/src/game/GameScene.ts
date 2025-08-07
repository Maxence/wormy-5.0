import Phaser from 'phaser'

export type Vector2 = { x: number; y: number }
export type PlayerState = { id: string; name: string; score: number; position: Vector2 }
export type FoodState = { id: string; position: Vector2; value: number }
export type WsState = { t: 'state'; roomId: string; leaderboard: { id: string; name: string; score: number }[]; players: PlayerState[]; foods: FoodState[]; mapSize: number; serverNow: number }

function computeZoom(score: number): number {
  const z = 1 / (1 + Math.sqrt(Math.max(0, score)) * 0.03)
  return Math.min(1, Math.max(0.3, z))
}

export default class GameScene extends Phaser.Scene {
  static KEY = 'GameScene'
  private playerId: string | null = null
  private latest: WsState | null = null
  private foodSprites: Phaser.GameObjects.Image[] = []
  private playerSprites: Map<string, Phaser.GameObjects.Image> = new Map()
  private foodPoolSize = 400
  private dotTextureKey = 'dot'

  constructor() {
    super(GameScene.KEY)
  }

  preload() {
    // generate a simple circle texture to reuse
    const g = this.make.graphics({ x: 0, y: 0, add: false })
    g.fillStyle(0xffffff, 1)
    g.fillCircle(8, 8, 8)
    g.generateTexture(this.dotTextureKey, 16, 16)
    g.destroy()
  }

  create() {
    // pre-allocate food sprites
    for (let i = 0; i < this.foodPoolSize; i++) {
      const s = this.add.image(0, 0, this.dotTextureKey)
      s.setVisible(false)
      s.setScale(0.15)
      s.setTint(0x2ecc71)
      this.foodSprites.push(s)
    }
    this.cameras.main.setBackgroundColor('#0a0a0a')
  }

  setSnapshot(s: WsState, playerId: string | null) {
    this.latest = s
    this.playerId = playerId
    this.renderNow()
  }

  private renderNow() {
    if (!this.latest) return
    const s = this.latest

    // players
    const playerIds = new Set<string>()
    for (const p of s.players) {
      let sprite = this.playerSprites.get(p.id)
      if (!sprite) {
        sprite = this.add.image(0, 0, this.dotTextureKey)
        this.playerSprites.set(p.id, sprite)
      }
      const isMe = p.id === this.playerId
      const r = Math.max(6, 6 + Math.sqrt(Math.max(0, p.score)) * 0.3)
      if (isMe) {
        // bright and bigger for the local player
        sprite.setTint(0xff5252)
        sprite.setScale(Math.max(r / 6, 1.2))
        sprite.setDepth(10)
      } else {
        sprite.setTint(0x00aaff)
        sprite.setScale(r / 8)
        sprite.setDepth(5)
      }
      sprite.setPosition(p.position.x, p.position.y)
      sprite.setVisible(true)
      playerIds.add(p.id)
      if (isMe) {
        this.cameras.main.centerOn(p.position.x, p.position.y)
        this.cameras.main.setZoom(computeZoom(p.score))
      }
    }
    // hide removed players
    for (const [id, spr] of this.playerSprites) {
      if (!playerIds.has(id)) {
        spr.destroy()
        this.playerSprites.delete(id)
      }
    }

    // foods
    let idx = 0
    const cam = this.cameras.main
    const view = new Phaser.Geom.Rectangle(cam.worldView.x, cam.worldView.y, cam.worldView.width, cam.worldView.height)
    const margin = 400 / Math.max(cam.zoom, 0.01)
    view.x -= margin; view.y -= margin; view.width += margin * 2; view.height += margin * 2
    for (const f of s.foods) {
      if (idx >= this.foodSprites.length) break
      if (!view.contains(f.position.x, f.position.y)) continue
      const spr = this.foodSprites[idx++]
      spr.setPosition(f.position.x, f.position.y)
      spr.setScale(0.15)
      spr.setVisible(true)
    }
    // hide rest
    for (; idx < this.foodSprites.length; idx++) this.foodSprites[idx].setVisible(false)
  }
}


