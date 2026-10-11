// One short pulse = ready, two = recorded, longer pulse = ended,
// three short pulses = error. All modes are stopped explicitly.
export class HapticFeedback {
  constructor(motor, modes, timers) {
    this.motor = motor
    this.modes = modes
    this.timers = timers
    this.pending = []
  }
  cancel() {
    this.pending.forEach(id => this.timers.clearTimeout(id))
    this.pending = []
    if (this.motor) { try { this.motor.stop() } catch (error) {} }
  }
  play(kind) {
    this.cancel()
    if (!this.motor) return 0
    const offsets = kind === 'recorded' ? [0, 100] : kind === 'error' ? [0, 100, 200] : [0]
    const long = kind === 'ended'
    const length = long ? 200 : 40
    const mode = long ? this.modes.long : this.modes.short
    const pulse = () => {
      try { this.motor.stop(); this.motor.start({ mode }) } catch (error) { return false }
      this.pending.push(this.timers.setTimeout(() => {
        try { this.motor.stop() } catch (error) {}
      }, length))
      return true
    }
    if (!pulse()) return 0
    offsets.slice(1).forEach(offset => this.pending.push(this.timers.setTimeout(pulse, offset)))
    // Ignore acceleration caused by the motor, plus a short settling tail.
    return offsets[offsets.length - 1] + length + 30
  }
}
