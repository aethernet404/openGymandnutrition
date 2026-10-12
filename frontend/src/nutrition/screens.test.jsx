// @vitest-environment happy-dom
//
// The diary screens against a mocked nutrition API: what they ask for, what they show, and what
// they send. Written the way views/CheckIn.test.jsx is — IS_REACT_ACT_ENVIRONMENT, native value
// setters for inputs, and the app's stores/sheets mocked at the module edge.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const m = vi.hoisted(() => ({
  user: { id: 'u1', name: 'Me', admin: false },
  sheets: [],
  toast: vi.fn(),
  confirm: vi.fn(),
  api: {
    getDay: vi.fn(), getConfig: vi.fn(), addEntries: vi.fn(), updateEntry: vi.fn(), deleteEntry: vi.fn(),
    listFoods: vi.fn(), createFood: vi.fn(), updateFood: vi.fn(), deleteFood: vi.fn(), getGoals: vi.fn(), putGoals: vi.fn(),
    getAdmin: vi.fn(), putAdmin: vi.fn(), getRange: vi.fn()
  }
}))

vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: m.user, S: {} })
  const useStore = sel => (sel ? sel(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({
    toast: (...a) => m.toast(...a),
    openSheet: render => { m.sheets.push(render); return { id: 's', close: () => {} } }
  })
  const useUI = sel => (sel ? sel(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('../sheets.jsx', () => ({ confirmSheet: (...a) => m.confirm(...a) }))
vi.mock('./api.js', () => m.api)

const { default: Diary } = await import('./Diary.jsx')
const { default: NutritionHomeCard } = await import('./HomeCard.jsx')
const { default: Nutrition } = await import('./Nutrition.jsx')
const { default: Goals } = await import('./Goals.jsx')
const { default: Foods } = await import('./Foods.jsx')
const { openAddSheet, openEditEntry, openFoodSheet } = await import('./sheets.jsx')

let host, root
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const mount = async (ui, path = '/') => {
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}>{ui}<Where /></MemoryRouter>)
  })
  await flush()
}
let where = ''
function Where() { const l = useLocation(); where = l.pathname + l.search; return null }
const text = () => host.textContent
const click = async el => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await flush() }
const byText = (sel, s) => { const all = [...host.querySelectorAll(sel)]; return all.find(e => e.textContent.trim() === s) || all.find(e => e.textContent.includes(s)) }
const setValue = async (el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
/** Render the most recently opened sheet into the page. */
let shown = []
async function showSheet(close = vi.fn()) {
  const render = m.sheets.at(-1)
  for (const old of shown) { act(() => old.r.unmount()); old.el.remove() }   // one sheet on screen, as in the app
  shown = []
  const sheet = document.createElement('div'); host.appendChild(sheet)
  const r = createRoot(sheet)
  await act(async () => { r.render(render(close)) })
  await flush()
  const out = { el: sheet, close, r }
  shown.push(out)
  return out
}

const today = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') })()
const dayOf = (over = {}) => ({
  date: today,
  entries: [
    { id: 'e1', meal: 'breakfast', name: 'Oats', source: 'quick', calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5, qty: 1 },
    { id: 'e2', meal: 'lunch', name: 'Chicken wrap', source: 'ai', calories: 650, protein_g: 40, carbs_g: 60, fat_g: 20, qty: 1 }
  ],
  totals: { calories: 950, protein_g: 50, carbs_g: 110, fat_g: 25 },
  byMeal: { breakfast: { calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5 }, lunch: { calories: 650, protein_g: 40, carbs_g: 60, fat_g: 20 }, dinner: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, snack: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 } },
  goals: { calories: 2400, protein_g: 160, carbs_g: null, fat_g: 70 },
  ...over
})

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  m.sheets.length = 0
  shown = []
  m.user = { id: 'u1', name: 'Me', admin: false }
  for (const f of Object.values(m.api)) f.mockReset()
  m.toast.mockReset(); m.confirm.mockReset()
  m.api.getDay.mockResolvedValue(dayOf())
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('Diary', () => {
  it("loads today and shows calories against the goal, the macros and each meal's entries", async () => {
    await mount(<Diary />)
    expect(m.api.getDay).toHaveBeenCalledWith(today)
    const t = text()
    expect(t).toContain('950')
    expect(t).toMatch(/2,?400/)
    expect(t).toMatch(/1,?450/)           // left
    expect(t).toContain('Oats')
    expect(t).toContain('Chicken wrap')
    expect(t).toContain('Breakfast'); expect(t).toContain('Snacks')
    expect(host.querySelector('[aria-label="Estimated by AI"]')).toBeTruthy()
  })

  it('says "over" and turns the bar once the goal is passed', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ totals: { calories: 2600, protein_g: 50, carbs_g: 110, fat_g: 25 } }))
    await mount(<Diary />)
    expect(text()).toContain('over')
    expect(host.querySelector('.nut-bar.over')).toBeTruthy()
  })

  it('invites you to set goals when there are none', async () => {
    m.api.getDay.mockResolvedValue(dayOf({ goals: null }))
    await mount(<Diary />)
    await click(byText('button', 'Set goals'))
    expect(where).toBe('/nutrition/goals')
  })

  it('previous / next day ask for that day, and Today comes back', async () => {
    await mount(<Diary />)
    await click(host.querySelector('[aria-label="Previous day"]'))
    const prev = m.api.getDay.mock.calls.at(-1)[0]
    expect(prev < today).toBe(true)
    expect(where).toContain('d=' + prev)
    expect(text()).toContain('Yesterday')
    await click(byText('button', 'Today'))
    expect(m.api.getDay.mock.calls.at(-1)[0]).toBe(today)
  })

  it('ignores a slow answer for a day you already left', async () => {
    let late
    m.api.getDay.mockImplementationOnce(() => new Promise(r => { late = r }))
    await mount(<Diary />)
    m.api.getDay.mockResolvedValue(dayOf({ date: '2000-01-01', entries: [], totals: { calories: 7, protein_g: 0, carbs_g: 0, fat_g: 0 }, byMeal: {} }))
    await click(host.querySelector('[aria-label="Previous day"]'))
    await act(async () => { late(dayOf()) }); await flush()
    expect(text()).not.toContain('Oats')
  })

  it('Add opens the sheet for that meal and that day; tapping an entry edits it', async () => {
    await mount(<Diary />)
    await click(host.querySelector('[aria-label="Add to dinner"]'))
    expect(m.sheets.length).toBe(1)
    const s = await showSheet()
    expect(s.el.textContent).toContain('Add food')
    expect(s.el.textContent).toContain('Dinner')
    await click(byText('.nut-entry', 'Oats'))
    expect(m.sheets.length).toBe(2)
  })

  it('shows a clear message when nutrition is switched off, and an error with retry otherwise', async () => {
    m.api.getDay.mockRejectedValue(Object.assign(new Error('off'), { status: 503, data: { code: 'off' } }))
    await mount(<Diary />)
    expect(text()).toContain('switched off')
    act(() => root.unmount()); root = createRoot(host)
    m.api.getDay.mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValue(dayOf())
    await mount(<Diary />)
    expect(text()).toContain('Could not load this day')
    await click(byText('button', 'Try again'))
    expect(text()).toContain('Oats')
  })
})

describe('sheets', () => {
  it('quick add sends calories and macros for the chosen day and meal, refreshes, and closes', async () => {
    const onSaved = vi.fn()
    m.api.addEntries.mockResolvedValue({})
    openAddSheet({ date: '2026-10-12', meal: 'lunch', onSaved })
    const s = await showSheet()
    const inputs = s.el.querySelectorAll('.nut-input input')
    await setValue(inputs[0], '420'); await setValue(inputs[1], '30')
    await setValue(s.el.querySelector('input[placeholder="Name (optional)"]'), 'Burrito')
    await click(byText('button', 'Add to lunch'))
    expect(m.api.addEntries).toHaveBeenCalledWith({ date: '2026-10-12', meal: 'lunch', name: 'Burrito', source: 'quick', calories: 420, protein_g: 30, carbs_g: 0, fat_g: 0 })
    expect(onSaved).toHaveBeenCalled(); expect(s.close).toHaveBeenCalled()
  })

  it('quick add refuses an empty calories box and sends nothing', async () => {
    openAddSheet({ date: '2026-10-12', meal: 'lunch', onSaved: vi.fn() })
    const s = await showSheet()
    await click(byText('button', 'Add to lunch'))
    expect(m.api.addEntries).not.toHaveBeenCalled()
    expect(m.toast).toHaveBeenCalledWith('Enter the calories')
    expect(s.close).not.toHaveBeenCalled()
  })

  it('a server error keeps the sheet open and says why', async () => {
    m.api.addEntries.mockRejectedValue(new Error('a day can hold at most 200 entries'))
    openAddSheet({ date: '2026-10-12', meal: 'lunch', onSaved: vi.fn() })
    const s = await showSheet()
    await setValue(s.el.querySelectorAll('.nut-input input')[0], '100')
    await click(byText('button', 'Add to lunch'))
    expect(m.toast).toHaveBeenCalledWith('a day can hold at most 200 entries')
    expect(s.close).not.toHaveBeenCalled()
  })

  it('from my foods: pick, set servings, add by foodId', async () => {
    const food = { id: 'f1', name: 'Protein shake', brand: '', source: 'custom', serving: { label: '1 scoop', grams: 30 }, per: { calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 } }
    m.api.listFoods.mockResolvedValue({ foods: [food] })
    m.api.addEntries.mockResolvedValue({})
    openAddSheet({ date: '2026-10-12', meal: 'snack', onSaved: vi.fn() })
    const s = await showSheet()
    await click(byText('button', 'My foods'))
    await flush()
    expect(m.api.listFoods).toHaveBeenCalledWith('recent', '')
    await click(byText('.nut-pick', 'Protein shake'))
    expect(s.el.textContent).toContain('120')
    await click(byText('button', 'Add to snacks'))
    expect(m.api.addEntries).toHaveBeenCalledWith({ date: '2026-10-12', meal: 'snack', source: 'food', foodId: 'f1', qty: 1 })
  })

  it('edit saves changes, can move the day, and delete asks first', async () => {
    const entry = { id: 'e1', meal: 'breakfast', name: 'Oats', source: 'quick', calories: 300, protein_g: 10, carbs_g: 50, fat_g: 5, qty: 1 }
    const onSaved = vi.fn()
    m.api.updateEntry.mockResolvedValue({}); m.api.deleteEntry.mockResolvedValue({})
    openEditEntry({ entry, date: '2026-10-12', onSaved })
    const s = await showSheet()
    await setValue(s.el.querySelectorAll('.nut-input input')[0], '350')
    await click(byText('button', 'Save'))
    expect(m.api.updateEntry).toHaveBeenCalledWith('2026-10-12', 'e1', { meal: 'breakfast', name: 'Oats', calories: 350, protein_g: 10, carbs_g: 50, fat_g: 5 })

    openEditEntry({ entry, date: '2026-10-12', onSaved })
    const s2 = await showSheet()
    await setValue(s2.el.querySelector('input[type="date"]'), '2026-10-13')
    await click(byText('button', 'Save'))
    expect(m.api.updateEntry.mock.calls.at(-1)[2].newDate).toBe('2026-10-13')

    await click(byText('button', 'Delete'))
    expect(m.confirm).toHaveBeenCalled()
    expect(m.api.deleteEntry).not.toHaveBeenCalled()
    await m.confirm.mock.calls[0][0].onConfirm()
    expect(m.api.deleteEntry).toHaveBeenCalledWith('2026-10-12', 'e1')
  })

  it('a new custom food posts per-serving macros; a lookup food is read-only', async () => {
    m.api.createFood.mockResolvedValue({})
    openFoodSheet({ onSaved: vi.fn() })
    const s = await showSheet()
    await setValue(s.el.querySelector('input[placeholder="Name"]'), 'Oats')
    const nums = s.el.querySelectorAll('.nut-input input[inputmode]')
    await setValue(nums[1], '150')   // [0] is grams
    await click(byText('button', 'Save'))
    expect(m.api.createFood).toHaveBeenCalledWith({ name: 'Oats', brand: '', serving: '1 serving', grams: null, ext: null, per: { calories: 150, protein_g: 0, carbs_g: 0, fat_g: 0 } })

    openFoodSheet({ food: { id: 'x', name: 'Yogurt', brand: 'B', source: 'off', serving: { label: '1 pot', grams: 150 }, per: { calories: 90, protein_g: 5, carbs_g: 12, fat_g: 2 } }, onSaved: vi.fn() })
    const ro = await showSheet()
    expect(ro.el.textContent).toContain('cannot be edited')
    expect(byText('button', 'Save') === undefined || ![...ro.el.querySelectorAll('button')].some(b => b.textContent === 'Save')).toBe(true)
  })
})

describe('Home card, router, goals, foods', () => {
  it('home card shows today against the goal', async () => {
    await mount(<NutritionHomeCard />)
    expect(text()).toContain('Nutrition')
    expect(text()).toMatch(/950/)
    await click(host.querySelector('.card'))
    expect(where).toBe('/nutrition')
  })

  it('home card disappears when nutrition is off, and stays friendly when the server is down', async () => {
    m.api.getDay.mockRejectedValue(Object.assign(new Error('off'), { data: { code: 'off' } }))
    await mount(<NutritionHomeCard />)
    expect(host.querySelector('.card')).toBeNull()
    act(() => root.unmount()); root = createRoot(host)
    m.api.getDay.mockRejectedValue(new Error('network'))
    await mount(<NutritionHomeCard />)
    expect(text()).toContain('Food & macros')
  })

  it('a guest is sent home instead of to a diary that cannot exist', async () => {
    m.user = null
    await mount(<Routes><Route path="/nutrition/*" element={<Nutrition />} /><Route path="/home" element={<div>home</div>} /></Routes>, '/nutrition')
    expect(where).toBe('/home')
    expect(m.api.getDay).not.toHaveBeenCalled()
  })

  it('goals: loads, saves the four targets, and returns to the diary', async () => {
    m.api.getGoals.mockResolvedValue({ goals: { calories: 2000, protein_g: null, carbs_g: null, fat_g: null } })
    m.api.putGoals.mockResolvedValue({})
    await mount(<Routes><Route path="/nutrition/goals" element={<Goals />} /><Route path="/nutrition" element={<div>diary</div>} /></Routes>, '/nutrition/goals')
    const inputs = host.querySelectorAll('.nut-input input')
    expect(inputs[0].value).toBe('2000')
    await setValue(inputs[1], '150')
    expect(text()).toContain('600')   // macros add up to 600 kcal vs a 2000 goal
    await click(byText('button', 'Save goals'))
    expect(m.api.putGoals).toHaveBeenCalledWith({ calories: 2000, protein_g: 150, carbs_g: null, fat_g: null })
    expect(where).toBe('/nutrition')
  })

  it('goals: the admin section is for admins only', async () => {
    m.api.getGoals.mockResolvedValue({ goals: null })
    m.api.getAdmin.mockResolvedValue({ enabled: true, aiDailyCap: 30, aiCapMax: 500, aiCapDefault: 30 })
    await mount(<Goals />)
    expect(m.api.getAdmin).not.toHaveBeenCalled()
    act(() => root.unmount()); root = createRoot(host)
    m.user = { id: 'a', admin: true }
    await mount(<Goals />)
    expect(text()).toContain('AI analyses per day')
    m.api.putAdmin.mockResolvedValue({ enabled: true, aiDailyCap: 12, aiCapMax: 500, aiCapDefault: 30 })
    await setValue(host.querySelector('.nut-cap input'), '12')
    await click(byText('button', 'Save'))
    expect(m.api.putAdmin).toHaveBeenCalledWith({ aiDailyCap: 12 })
  })

  it('foods: lists by scope, stars a food', async () => {
    const f = { id: 'f1', name: 'Shake', brand: '', source: 'custom', favorite: false, serving: { label: '1 scoop', grams: 30 }, per: { calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 } }
    m.api.listFoods.mockResolvedValue({ foods: [f] })
    m.api.updateFood.mockResolvedValue({})
    await mount(<Foods />)
    expect(text()).toContain('Shake')
    await click(host.querySelector('[aria-label="Add to favourites"]'))
    expect(m.api.updateFood).toHaveBeenCalledWith('f1', { favorite: true })
    await click(byText('button', 'Favourites'))
    expect(m.api.listFoods).toHaveBeenLastCalledWith('favorite', '')
  })
})
