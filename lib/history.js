export const HISTORY_KEY = 'jab-speed-v1'
export const MAX_SESSIONS = 30
export const MAX_PUNCHES = 200
export function loadHistory(storage) {
  const value = storage.getItem(HISTORY_KEY, [])
  if (!Array.isArray(value) || value.some(s => !s || !Number.isFinite(s.startedAt) ||
    !Array.isArray(s.punches) || !s.punches.length || s.punches.some(p => !p || !Number.isFinite(p.speed) ||
      p.speed <= 0 || !Number.isFinite(p.at) || !Number.isFinite(p.duration)))) throw new Error('Invalid history')
  return value.slice(0, MAX_SESSIONS)
}
export function saveSession(storage, history, session) {
  if (!session || !session.punches.length) return history
  const next = [session, ...history.filter(s => s.startedAt !== session.startedAt)].slice(0, MAX_SESSIONS)
  storage.setItem(HISTORY_KEY, next)
  return next
}
export function stats(punches) {
  if (!punches.length) return { count: 0, best: 0, average: 0 }
  return { count: punches.length, best: Math.max(...punches.map(p => p.speed)),
    average: punches.reduce((sum, p) => sum + p.speed, 0) / punches.length }
}
