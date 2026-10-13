// Every call the Nutrition screens make, in one place. Thin wrappers over lib/api.js (session
// cookie, base path, timeouts, paired-phone base) — the routes are api/nutrition/routes.js.
import { api } from '../lib/api.js'

const q = o => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, v)
  return p.toString()
}
const send = (method, path, body) => api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })

export const getConfig = () => api('/api/nutrition/config')
export const getDay = date => api('/api/nutrition/day?' + q({ date }))
export const getRange = (from, to) => api('/api/nutrition/range?' + q({ from, to }))
export const addEntries = body => send('POST', '/api/nutrition/entries', body)
export const updateEntry = (date, id, body) => send('PUT', '/api/nutrition/entries?' + q({ date, id }), body)
export const deleteEntry = (date, id) => send('DELETE', '/api/nutrition/entries?' + q({ date, id }))
export const listFoods = (scope = 'all', text = '') => api('/api/nutrition/foods?' + q({ scope, q: text }))
export const createFood = body => send('POST', '/api/nutrition/foods', body)
export const updateFood = (id, body) => send('PUT', '/api/nutrition/foods?' + q({ id }), body)
export const deleteFood = id => send('DELETE', '/api/nutrition/foods?' + q({ id }))
export const getGoals = () => api('/api/nutrition/goals')
export const putGoals = body => send('PUT', '/api/nutrition/goals', body)
export const getAdmin = () => api('/api/admin/nutrition')
export const putAdmin = body => send('PUT', '/api/admin/nutrition', body)

// One source per request, so the fast one is on screen while the slow one is still working. The server
// gives a source about 21 s (10 s, one retry at 8 s); the client waits a little longer than that.
export const searchFoods = (text, source = 'all') => api('/api/nutrition/search?' + q({ q: text, source }), { timeout: 30000 })
export const lookupBarcode = code => api('/api/nutrition/barcode?' + q({ code }), { timeout: 20000 })
export const testUsda = () => send('POST', '/api/admin/nutrition/test-usda', {})

// The model has up to 90 s on the server; the client waits a little longer than that.
export const analyze = body => api('/api/nutrition/analyze', { method: 'POST', body: JSON.stringify(body), timeout: 100000 })
export const setCoachShare = share => send('PUT', '/api/nutrition/coach-share', { share })
