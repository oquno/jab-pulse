import * as ui from '@zos/ui'
import { Accelerometer, FREQ_MODE_HIGH, Vibrator, VIBRATOR_SCENE_SHORT_STRONG, VIBRATOR_SCENE_DURATION } from '@zos/sensor'
import { LocalStorage } from '@zos/storage'
import { setPageBrightTime, pauseDropWristScreenOff, resetDropWristScreenOff } from '@zos/display'
import { COLORS as C } from 'zosLoader:./index.page.[pf].layout.js'
import { JabDetector } from '../../../lib/jab-detector'
import { HapticFeedback } from '../../../lib/haptic-feedback'
import { loadHistory, saveSession, stats, MAX_PUNCHES } from '../../../lib/history'

// Require a more deliberate acceleration before opening a stroke window.
const THRESHOLDS = [8, 6, 4]
const LEVELS = ['低', '標準', '高']
const SETTINGS_KEY = 'jab-settings-v1'
const pad = n => String(n).padStart(2, '0')
const stamp = value => {
  const d = new Date(value)
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

Page({
  onInit() {
    this.widgets = []
    this.tab = 'measure'
    this.historyIndex = 0
    this.punchPage = 0
    this.running = false
    this.storage = new LocalStorage()
    this.history = []
    this.settings = { sensitivity: 1, kmh: false }
    this.message = ''
    let motor = null
    try { motor = new Vibrator() } catch (error) {}
    this.haptic = new HapticFeedback(motor,
      { short: VIBRATOR_SCENE_SHORT_STRONG, long: VIBRATOR_SCENE_DURATION },
      { setTimeout, clearTimeout })
    try {
      this.history = loadHistory(this.storage)
      const saved = this.storage.getItem(SETTINGS_KEY, this.settings)
      if (saved && [0, 1, 2].indexOf(saved.sensitivity) >= 0) {
        this.settings = { sensitivity: saved.sensitivity, kmh: saved.kmh === true }
      }
    } catch (error) {
      this.storageBlocked = true
      this.message = '保存データを読めません'
    }
    this.sensorCallback = () => this.sample()
  },
  build() { this.render() },
  add(type, options) {
    const w = ui.createWidget(type, options)
    this.widgets.push(w)
    return w
  },
  text(text, y, size = 22, color = C.white, x = 20, w = 350, h = 32) {
    return this.add(ui.widget.TEXT, { x, y, w, h, text, text_size: size, color,
      align_h: ui.align.CENTER_H, align_v: ui.align.CENTER_V })
  },
  button(text, x, y, w, callback, primary = false, h = 48) {
    return this.add(ui.widget.BUTTON, { x, y, w, h, text, text_size: 22, radius: 14,
      color: primary ? C.background : C.white,
      normal_color: primary ? C.accent : C.panel,
      press_color: primary ? 0x9dc64f : 0x334455, click_func: callback })
  },
  value(speed) { return (speed * (this.settings.kmh ? 3.6 : 1)).toFixed(1) },
  unit() { return this.settings.kmh ? 'km/h' : 'm/s' },
  summaryText(s) { return `${s.count} 発   平均 ${this.value(s.average)} ${this.unit()}` },
  bestText(s) { return `BEST  ${this.value(s.best)} ${this.unit()}` },
  render() {
    this.widgets.forEach(w => ui.deleteWidget(w))
    this.widgets = []
    this.add(ui.widget.FILL_RECT, { x: 0, y: 0, w: 390, h: 450, color: C.background })
    this.text('JAB / SPEED', 14, 24, C.accent)
    if (this.tab === 'measure') this.renderMeasure()
    if (this.tab === 'history') this.renderHistory()
    if (this.tab === 'settings') this.renderSettings()
    if (!this.running) {
      const tabs = [['measure', '計測'], ['history', '履歴'], ['settings', '設定']]
      tabs.forEach((t, i) => this.button(t[1], 20 + 120 * i, 393, 110, () => {
        this.tab = t[0]; this.message = ''; this.render()
      }, this.tab === t[0], 42))
    }
  },
  renderMeasure() {
    const punches = this.session ? this.session.punches : []
    const s = stats(punches)
    this.statusWidget = this.text(this.message || this.statusText(), 53, 20, C.muted)
    const last = punches.length ? punches[punches.length - 1].speed : null
    this.speedWidget = this.text(last === null ? '--.-' : this.value(last), 88, 76, C.white, 20, 350, 90)
    this.text(`推定ハンドスピード / ${this.unit()}`, 181, 19, C.muted)
    this.summaryWidget = this.text(this.summaryText(s), 222, 22)
    this.bestWidget = this.text(this.bestText(s), 258, 22, C.accent)
    if (!this.running) {
      this.button(this.unsaved ? '保存を再試行' : '計測を開始', 40, 307, 310,
        () => this.unsaved ? this.stop() : this.start(), true, 54)
      this.text('ジャブ側の手首に装着', 362, 18, C.muted, 20, 350, 24)
    } else {
      this.button('終了して保存', 40, 310, 310, () => this.stop(), true, 58)
      this.text('1回振動＝準備  2回＝記録', 382, 18, C.muted)
      this.sensorWidget = this.text(this.sensorText(), 414, 17, C.muted, 20, 350, 24)
    }
  },
  statusText() {
    if (!this.running) return this.unsaved ? '未保存 / 保存を再試行' :
      this.session && this.session.punches.length ? '記録を保存しました' : '同じ条件で速さを比較'
    if (!this.lastSample || Date.now() - this.lastSample > 1500) return 'センサーの応答を待っています'
    const labels = { calibrating: '腕を静止して補正中…', ready: '準備完了 / ジャブをどうぞ',
      motion: '計測中…', settling: '構えに戻して静止' }
    return labels[this.detector.status]
  },
  sensorText() {
    const hz = this.detector && this.detector.sampleInterval ? Math.round(1000 / this.detector.sampleInterval) : 0
    return hz ? `センサー ${hz} Hz${hz < 15 ? ' / 取得頻度が不足' : ' / 200発で終了'}` : 'センサーの応答を待っています'
  },
  feedback(kind, now = Date.now()) {
    const duration = this.haptic.play(kind)
    if (duration && this.running && this.detector) this.detector.suppressUntil(now + duration)
  },
  start() {
    if (this.unsaved) { this.stop(); return }
    if (this.storageBlocked) { this.message = '保存不可 / 再起動してください'; this.render(); return }
    this.haptic.cancel()
    this.message = ''
    this.session = { startedAt: Date.now(), endedAt: null, sensitivity: this.settings.sensitivity, detectorVersion: 3, punches: [] }
    this.detector = new JabDetector(THRESHOLDS[this.settings.sensitivity])
    this.lastSample = null
    this.running = true
    try {
      this.sensor = new Accelerometer()
      this.sensor.onChange(this.sensorCallback)
      this.sensor.setFreqMode(FREQ_MODE_HIGH)
      this.sensor.start()
      setPageBrightTime({ brightTime: 30 * 60 * 1000 })
      pauseDropWristScreenOff({ duration: 0 })
      this.timer = setInterval(() => {
        if (Date.now() - this.session.startedAt >= 30 * 60 * 1000) this.stop('30分で自動終了しました')
        else if (Date.now() - (this.lastSample || this.session.startedAt) > 8000) this.stop('センサー応答なし / 再試行')
        else {
          if (this.statusWidget) this.statusWidget.setProperty(ui.prop.TEXT, this.message || this.statusText())
          if (this.sensorWidget) this.sensorWidget.setProperty(ui.prop.TEXT, this.sensorText())
        }
      }, 250)
    } catch (error) { this.stop('センサーを開始できません'); return }
    this.render()
  },
  sample() {
    if (!this.running) return
    try {
      const now = Date.now()
      const raw = this.sensor.getCurrent()
      if (!raw || ![raw.x, raw.y, raw.z].every(Number.isFinite)) return
      this.lastSample = now
      const previousStatus = this.detector.status
      const punch = this.detector.update(raw, now)
      if (this.detector.status === 'ready' && previousStatus !== 'ready') this.feedback('ready', now)
      if (!punch) return
      this.session.punches.push(punch)
      if (!this.persist()) { this.stop(); return }
      this.feedback('recorded', now)
      const s = stats(this.session.punches)
      this.speedWidget.setProperty(ui.prop.TEXT, this.value(punch.speed))
      this.summaryWidget.setProperty(ui.prop.TEXT, this.summaryText(s))
      this.bestWidget.setProperty(ui.prop.TEXT, this.bestText(s))
      if (s.count >= MAX_PUNCHES) this.stop('200発を記録しました')
    } catch (error) { this.stop('センサーエラー / 計測終了') }
  },
  persist() {
    try {
      this.history = saveSession(this.storage, this.history, this.session)
      this.unsaved = false
      return true
    } catch (error) { this.unsaved = true; return false }
  },
  release() {
    if (this.haptic) this.haptic.cancel()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.sensor) {
      try { this.sensor.offChange(this.sensorCallback) } catch (error) {}
      try { this.sensor.stop() } catch (error) {}
      this.sensor = null
    }
    try { resetDropWristScreenOff() } catch (error) {}
    try { setPageBrightTime({ brightTime: 10000 }) } catch (error) {}
  },
  stop(message = '') {
    this.running = false
    this.release()
    if (this.session) this.session.endedAt = Date.now()
    const saved = this.persist()
    this.feedback(saved && !message.includes('センサー') ? 'ended' : 'error')
    this.message = saved ? (message || (this.session && this.session.punches.length ?
      '記録を保存しました' : '検出なし / 記録はありません')) : '保存失敗 / 再試行してください'
    this.render()
  },
  renderHistory() {
    if (!this.history.length) {
      this.text(this.storageBlocked ? '履歴を読めません' : 'まだ記録がありません', 135, 25)
      this.text('計測を始めて一発打ちましょう', 186, 20, C.muted)
      this.text('直近30回・各200発まで保存', 308, 20, C.muted)
      return
    }
    this.historyIndex = Math.min(this.historyIndex, this.history.length - 1)
    const s = this.history[this.historyIndex]
    const summary = stats(s.punches)
    this.text(`${stamp(s.startedAt)}   ${this.historyIndex + 1}/${this.history.length}`, 54, 21, C.muted)
    this.text(this.bestText(summary), 92, 32, C.accent, 10, 370, 43)
    this.text(this.summaryText(summary), 140, 22)
    const pages = Math.ceil(s.punches.length / 3)
    this.punchPage = Math.min(this.punchPage, pages - 1)
    s.punches.slice().reverse().slice(this.punchPage * 3, this.punchPage * 3 + 3).forEach((p, i) => {
      this.text(`#${s.punches.length - this.punchPage * 3 - i}    ${this.value(p.speed)} ${this.unit()}    ${p.duration} ms`, 184 + i * 32, 20)
    })
    this.button(`各打 ${this.punchPage + 1}/${pages} 次へ`, 55, 286, 280, () => {
      this.punchPage = (this.punchPage + 1) % pages; this.render()
    }, false, 42)
    this.button('新しい回', 20, 340, 165, () => {
      this.historyIndex = Math.max(0, this.historyIndex - 1); this.punchPage = 0; this.render()
    }, false, 42)
    this.button('過去の回', 205, 340, 165, () => {
      this.historyIndex = Math.min(this.history.length - 1, this.historyIndex + 1); this.punchPage = 0; this.render()
    }, false, 42)
  },
  changeSettings(change) {
    const next = { ...this.settings, ...change }
    try { this.storage.setItem(SETTINGS_KEY, next); this.settings = next; this.message = '' }
    catch (error) { this.message = '設定を保存できません' }
    this.render()
  },
  renderSettings() {
    this.button(`単位 : ${this.unit()}`, 30, 61, 330, () => this.changeSettings({ kmh: !this.settings.kmh }))
    this.button(`検出感度 : ${LEVELS[this.settings.sensitivity]}`, 30, 121, 330, () =>
      this.changeSettings({ sensitivity: (this.settings.sensitivity + 1) % 3 }))
    this.text('ジャブ側に時計を着けて開始', 188, 21)
    this.text('短い振動1回で準備完了', 222, 21)
    this.text('短い振動2回で記録成功', 256, 21)
    this.text('実速度ではなく手首の推定値', 299, 19, C.muted)
    this.text(this.message || '他の腕の動きも検出されます', 329, 19, this.message ? C.danger : C.muted)
    this.text('履歴は時計内に保存', 358, 18, C.muted, 20, 350, 25)
  },
  onDestroy() {
    this.running = false
    this.release()
    if (this.session) { this.session.endedAt = Date.now(); this.persist() }
  },
})
