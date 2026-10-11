import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const moduleFrom = async path => import(`data:text/javascript;base64,${Buffer.from(readFileSync(new URL(path, import.meta.url))).toString('base64')}`)
const { JabDetector } = await moduleFrom('../lib/jab-detector.js')
const { HapticFeedback } = await moduleFrom('../lib/haptic-feedback.js')
const { loadHistory, saveSession, stats, HISTORY_KEY } = await moduleFrom('../lib/history.js')

function rig(step = 10) {
  const detector = new JabDetector()
  let now = 0
  const events = []
  const feed = (x, count, z = 981, y = 0) => {
    for (let i = 0; i < count; i++) {
      now += step
      const result = detector.update({ x, y, z }, now)
      if (result) events.push(result)
    }
  }
  return { detector, events, feed, time: () => now }
}

test('stationary noise never becomes a punch; moving calibration does not arm', () => {
  const r = rig()
  for (let i = 0; i < 200; i++) r.feed(i % 2 ? 200 : -200, 1)
  assert.equal(r.detector.ready, false)
  r.feed(0, 170)
  assert.equal(r.detector.ready, true)
  for (let i = 0; i < 1000; i++) r.feed(i % 2 ? 10 : -10, 1)
  assert.equal(r.events.length, 0)
})

test('integrates a short acceleration pulse and rejects the return in cooldown', () => {
  const r = rig()
  r.feed(0, 170)
  r.feed(2000, 15)
  r.feed(-2000, 15)
  assert.equal(r.events.length, 1)
  // 20 m/s² for 150 ms gives 3 m/s; the sampled ramp loses half an interval.
  assert.ok(Math.abs(r.events[0].speed - 3) < 0.15)
  r.feed(2000, 15)
  r.feed(-2000, 15)
  assert.equal(r.events.length, 1)
  r.feed(0, 100)
  r.feed(2000, 15)
  r.feed(-2000, 15)
  assert.equal(r.events.length, 2)
})

test('rejects spikes, clipped data, overlong motion, missing and stale samples', () => {
  for (const motion of [r => { r.feed(5000, 1); r.feed(0, 20) },
    r => { r.feed(16000, 1); r.feed(0, 100) },
    r => { r.feed(2000, 10); r.feed(16000, 1); r.feed(0, 100) },
    r => { r.feed(2000, 80); r.feed(0, 100) }]) {
    const r = rig(); r.feed(0, 170); motion(r)
    assert.equal(r.events.length, 0)
  }
  const r = rig(); r.feed(0, 170); r.feed(2000, 10)
  assert.equal(r.detector.update({ x: NaN, y: 0, z: 981 }, r.time() + 10), null)
  r.detector.update({ x: 0, y: 0, z: 981 }, r.time() + 500)
  assert.equal(r.detector.ready, false)
  assert.equal(r.detector.stroke, null)
})

test('detects short jabs at 20, 25, 50 and 100 Hz without requiring five samples', () => {
  for (const step of [50, 40, 20, 10]) {
    const r = rig(step)
    r.feed(0, Math.ceil(1600 / step))
    assert.equal(r.detector.ready, true, `${1000 / step} Hz calibration`)
    for (let i = 0; i < 3; i++) {
      r.feed(1200, Math.ceil(120 / step))
      r.feed(-1200, Math.ceil(120 / step))
      r.feed(0, Math.ceil(550 / step))
    }
    assert.equal(r.events.length, 3, `${1000 / step} Hz detection`)
    assert.ok(r.events.every(p => p.speed >= 1 && p.speed <= 2.2))
    assert.ok(Math.abs(1000 / r.detector.sampleInterval - 1000 / step) < 0.1)
  }
})

test('returns to ready after changing the guard angle and detects another jab', () => {
  const r = rig(40)
  r.feed(0, 40)
  r.feed(1200, 3); r.feed(-1200, 3)
  assert.equal(r.events.length, 1)
  // The resting gravity vector rotates 90 degrees after the return.
  r.feed(981, 20, 0)
  assert.equal(r.detector.status, 'ready')
  r.feed(981, 3, 0, 1200); r.feed(981, 3, 0, -1200)
  assert.equal(r.events.length, 2)
})

test('pure wrist orientation changes and single-sample jolts are not counted', () => {
  for (const step of [50, 40, 10]) {
    const r = rig(step)
    r.feed(0, Math.ceil(1600 / step))
    r.feed(981, Math.ceil(600 / step), 0)
    r.feed(0, Math.ceil(600 / step), -981)
    r.feed(0, Math.ceil(600 / step))
    assert.equal(r.events.length, 0, `rotation at ${1000 / step} Hz`)
    r.feed(5000, 1); r.feed(0, Math.ceil(600 / step))
    assert.equal(r.events.length, 0, `spike at ${1000 / step} Hz`)
  }
})

function memory() {
  const data = new Map()
  return { getItem: (k, fallback) => data.has(k) ? structuredClone(data.get(k)) : fallback,
    setItem: (k, v) => data.set(k, structuredClone(v)) }
}
const session = i => ({ startedAt: i, punches: [{ speed: 3, at: i + 1, duration: 150 }] })

test('persists after reload, replaces active session, retains 30 sessions and detects corruption', () => {
  const storage = memory()
  let history = []
  for (let i = 1; i <= 35; i++) history = saveSession(storage, history, session(i))
  history = loadHistory(storage)
  assert.equal(history.length, 30)
  assert.equal(history[0].startedAt, 35)
  const current = session(35)
  current.punches.push({ speed: 5, at: 37, duration: 100 })
  history = saveSession(storage, history, current)
  assert.deepEqual(stats(history[0].punches), { count: 2, best: 5, average: 4 })
  assert.equal(history.length, 30)
  storage.setItem(HISTORY_KEY, 'broken')
  assert.throws(() => loadHistory(storage))
  assert.throws(() => saveSession({ setItem() { throw Error('disk full') } }, [], session(1)))
})

function pageRig() {
  let page
  let now = 10000
  const widgets = new Set()
  const storage = memory()
  const sensors = []
  const timers = new Set()
  const timeouts = new Map()
  const pulses = []
  let nextTimeout = 0
  let vibrating = false
  const advance = ms => {
    const end = now + ms
    while (true) {
      const due = [...timeouts].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at; timeouts.delete(due[0]); due[1].cb()
    }
    now = end
  }
  class Motor {
    start({ mode }) { vibrating = true; pulses.push({ at: now, mode }) }
    stop() { vibrating = false }
  }
  const ui = { widget: { TEXT: 'TEXT', BUTTON: 'BUTTON', FILL_RECT: 'RECT' },
    align: { CENTER_H: 0, CENTER_V: 0 }, prop: { TEXT: 'text' },
    createWidget(type, options) {
      const widget = { type, ...options, setProperty(k, value) { this[k] = value } }
      widgets.add(widget)
      return widget
    }, deleteWidget(w) { assert.ok(widgets.delete(w)) } }
  class Sensor {
    constructor() { sensors.push(this) }
    onChange(cb) { this.callback = cb }
    offChange(cb) { assert.equal(this.callback, cb); this.callback = null }
    start() { this.started = true }
    stop() { this.started = false }
    setFreqMode() {}
    getCurrent() { return this.raw }
  }
  class Clock extends Date { static now() { return now } }
  const source = readFileSync(new URL('../page/gt/home/index.page.js', import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '')
  vm.runInNewContext(source, {
    ui, C: { background: 0, white: 1, panel: 2, muted: 3, accent: 4 },
    Accelerometer: Sensor, FREQ_MODE_HIGH: 2, LocalStorage: function() { return storage },
    Vibrator: Motor, VIBRATOR_SCENE_SHORT_STRONG: 'short', VIBRATOR_SCENE_DURATION: 'long', HapticFeedback,
    setPageBrightTime() {}, pauseDropWristScreenOff() {}, resetDropWristScreenOff() {},
    JabDetector, loadHistory, saveSession, stats, MAX_PUNCHES: 200,
    Date: Clock, setInterval(cb) { timers.add(cb); return cb }, clearInterval(cb) { timers.delete(cb) },
    setTimeout(cb, delay) { const id = ++nextTimeout; timeouts.set(id, { cb, at: now + delay }); return id },
    clearTimeout(id) { timeouts.delete(id) },
    Page(definition) { page = definition },
  })
  page.onInit(); page.build()
  return { page, storage, widgets, sensors, timers, timeouts, pulses, advance, vibrating: () => vibrating,
    feed(x, count) {
      for (let i = 0; i < count; i++) {
        advance(10)
        const sensor = sensors[sensors.length - 1]
        if (!sensor.started) break
        sensor.raw = { x, y: 0, z: 981 }; sensor.callback()
      }
    },
    click(label) {
      const widget = [...widgets].find(w => w.type === 'BUTTON' && w.text === label)
      assert.ok(widget, label); widget.click_func()
    },
  }
}

test('page workflow records punches, reloads history, changes units and releases sensors', () => {
  const r = pageRig()
  r.click('計測を開始')
  r.feed(0, 170); r.feed(2000, 15); r.feed(-2000, 15)
  assert.equal(r.page.session.punches.length, 1)
  assert.equal(loadHistory(r.storage)[0].punches.length, 1)
  r.click('終了して保存')
  assert.equal(r.sensors[0].started, false)
  assert.equal(r.timers.size, 0)
  r.click('履歴')
  assert.ok([...r.widgets].some(w => w.text && w.text.includes('#1')))
  r.click('設定'); r.click('単位 : m/s')
  assert.equal(r.page.unit(), 'km/h')
  for (const w of r.widgets) {
    assert.ok(w.x >= 0 && w.y >= 0 && w.x + w.w <= 390 && w.y + w.h <= 450)
  }
  r.page.onDestroy()
})

test('failed writes keep an unsaved session for retry; destruction preserves completed punches', () => {
  const r = pageRig()
  r.click('計測を開始'); r.feed(0, 170)
  const write = r.storage.setItem
  r.storage.setItem = () => { throw Error('disk full') }
  r.feed(2000, 15); r.feed(-2000, 15)
  assert.equal(r.page.running, false)
  assert.equal(r.page.unsaved, true)
  assert.equal(r.page.session.punches.length, 1)
  r.click('履歴'); r.click('計測')
  r.storage.setItem = write
  r.click('保存を再試行')
  assert.equal(r.page.unsaved, false)
  assert.equal(loadHistory(r.storage)[0].punches.length, 1)
  r.click('計測を開始'); r.feed(0, 170); r.feed(2000, 15); r.feed(-2000, 15)
  r.page.onDestroy()
  assert.equal(r.sensors[1].started, false)
  assert.equal(loadHistory(r.storage).length, 2)
})

test('haptic cues signal ready once, saved twice, ready again and end; destruction cancels pulses', () => {
  const r = pageRig()
  r.click('計測を開始'); r.feed(0, 170)
  assert.deepEqual(r.pulses.map(p => p.mode), ['short'])
  r.feed(0, 50)
  assert.equal(r.pulses.length, 1)
  r.feed(2000, 15); r.feed(-2000, 15)
  assert.equal(loadHistory(r.storage)[0].punches.length, 1)
  assert.equal(r.pulses.length, 3)
  assert.equal(r.pulses[2].at - r.pulses[1].at, 100)
  r.feed(0, 60)
  assert.equal(r.pulses.length, 4)
  r.click('終了して保存')
  assert.equal(r.pulses.at(-1).mode, 'long')
  r.advance(200)
  assert.equal(r.vibrating(), false)
  r.page.feedback('recorded')
  const count = r.pulses.length
  r.page.onDestroy(); r.advance(500)
  assert.equal(r.pulses.length, count)
  assert.equal(r.timeouts.size, 0)
  assert.equal(r.vibrating(), false)
})

test('failed save gives three error pulses without a recorded cue', () => {
  const r = pageRig()
  r.click('計測を開始'); r.feed(0, 170)
  r.storage.setItem = () => { throw Error('disk full') }
  r.feed(2000, 15); r.feed(-2000, 15); r.advance(300)
  assert.equal(r.page.unsaved, true)
  assert.deepEqual(r.pulses.slice(1).map(p => p.mode), ['short', 'short', 'short'])
  assert.equal(r.pulses[2].at - r.pulses[1].at, 100)
  assert.equal(r.pulses[3].at - r.pulses[2].at, 100)
  assert.equal(r.vibrating(), false)
})

test('motor acceleration is ignored without losing calibration or generating punches', () => {
  for (const step of [10, 50]) {
    const r = rig(step)
    r.feed(0, Math.ceil(1600 / step))
    r.detector.suppressUntil(r.time() + 170)
    r.feed(16000, Math.floor(160 / step))
    assert.equal(r.detector.ready, true)
    r.feed(0, Math.ceil(500 / step))
    assert.equal(r.events.length, 0)
    r.feed(1200, Math.ceil(120 / step)); r.feed(-1200, Math.ceil(120 / step))
    assert.equal(r.events.length, 1)
  }
})
