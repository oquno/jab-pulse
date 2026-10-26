// Zepp input cm/s²; output unvalidated wrist velocity estimate in m/s.
// Gravity is held fixed during each stroke. Rotation remains an error source.
export class JabDetector {
  constructor(threshold = 3.5) { this.threshold = threshold; this.reset() }
  reset() {
    this.gravity = null
    this.previous = null
    this.lastTime = null
    this.stableSince = null
    this.samples = 0
    this.ready = false
    this.stroke = null
    this.cooldownUntil = 0
    this.settledSince = null
    this.status = 'calibrating'
    this.restMagnitude = 9.81
    this.sampleInterval = 0
    this.rejected = 0
    this.lastReject = ''
    this.ignoredUntil = 0
  }
  update(raw, now) {
    if (!raw || ![raw.x, raw.y, raw.z, now].every(Number.isFinite)) return null
    const a = [raw.x / 100, raw.y / 100, raw.z / 100]
    if (this.lastTime !== null && now <= this.lastTime) return null
    const gap = this.lastTime === null ? 0 : now - this.lastTime
    if (gap > 250) { this.reset(); this.lastReject = 'gap' }
    const dt = gap > 0 && gap <= 250 ? gap / 1000 : 0
    if (dt) this.sampleInterval = this.sampleInterval ? this.sampleInterval * 0.9 + gap * 0.1 : gap
    this.lastTime = now
    if (now < this.ignoredUntil) { this.previous = null; return null }
    if (a.some(v => Math.abs(v) >= 150)) { this.reset(); return null }
    if (!this.gravity) {
      this.gravity = a.slice(); this.previous = a.slice(); this.stableSince = now
      return null
    }
    const delta = this.previous ? Math.hypot(...a.map((v, i) => v - this.previous[i])) : 0
    const linear = a.map((v, i) => v - this.gravity[i])
    const magnitude = Math.hypot(...linear)
    this.previous = a.slice()
    if (!this.ready) {
      if (delta > 1.5 || magnitude > 1.8 || Math.abs(Math.hypot(...a) - 9.81) > 2) {
        this.stableSince = now; this.samples = 0; this.gravity = a.slice()
      } else {
        this.samples++
        this.followGravity(a, dt, 0.15)
      }
      if (now - this.stableSince >= 1000 && this.samples >= 5) {
        this.restMagnitude = Math.hypot(...this.gravity)
        this.ready = true; this.status = 'ready'; this.settledSince = now
      }
      return null
    }
    if (this.stroke) {
      const s = this.stroke
      s.velocity = s.velocity.map((v, i) => v + (linear[i] + s.last[i]) * 0.5 * dt)
      s.last = linear; s.samples++
      s.peak = Math.max(s.peak, Math.hypot(...s.velocity))
      const elapsed = now - s.start
      const projected = linear.reduce((sum, v, i) => sum + v * s.direction[i], 0)
      if (projected >= this.threshold * 0.5) s.driveSamples++
      if (projected < -this.threshold * 0.35) s.braked = true
      if (magnitude < 2) { if (s.quietSince === null) s.quietSince = now } else s.quietSince = null
      if ((s.braked && elapsed >= 40) || (s.quietSince !== null && now - s.quietSince >= 50) || elapsed > 650) {
        this.finish(now)
        // Require a sustained drive and a meaningful integrated speed to keep
        // small incidental wrist movements from being recorded as punches.
        if (elapsed >= 40 && elapsed <= 650 && s.driveSamples >= 3 && s.peak >= 0.4 && s.peak <= 20) {
          return { speed: Math.round(s.peak * 100) / 100, duration: elapsed, at: now }
        }
        this.rejected++
        this.lastReject = elapsed > 650 ? 'long' : s.driveSamples < 3 ? 'samples' : 'speed'
      }
      return null
    }
    const radial = Math.abs(Math.hypot(...a) - this.restMagnitude)
    if (this.status === 'ready' && magnitude >= this.threshold && radial >= 0.45 && dt > 0) {
      this.stroke = { start: now, velocity: linear.map(v => v * dt * 0.5), last: linear,
        direction: linear.map(v => v / magnitude), peak: 0, samples: 1, driveSamples: 1, quietSince: null, braked: false }
      this.status = 'motion'; this.settledSince = null
    } else {
      // Always adapt outside a stroke, including after a changed guard angle.
      // The old residual-only gate could remain locked in settling forever.
      this.followGravity(a, dt, this.status === 'settling' || radial < 0.45 ? 0.1 : 0.35)
      const still = delta < 1.5 && Math.abs(Math.hypot(...a) - 9.81) < 2
      if (still) {
        if (this.settledSince === null) this.settledSince = now
        if (now >= this.cooldownUntil && now - this.settledSince >= 150) this.status = 'ready'
      } else this.settledSince = null
    }
    return null
  }
  finish(now) {
    this.stroke = null; this.cooldownUntil = now + 300
    this.settledSince = null; this.status = 'settling'
  }
  followGravity(a, dt, seconds) {
    const alpha = 1 - Math.exp(-dt / seconds)
    this.gravity = this.gravity.map((v, i) => v + alpha * (a[i] - v))
  }
  suppressUntil(time) { this.ignoredUntil = Math.max(this.ignoredUntil, time) }
}
