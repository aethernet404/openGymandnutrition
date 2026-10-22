// @vitest-environment happy-dom
//
// Reading a label from photos, on screen: several photos at once, removing one, the size cap, the editable review (columns,
// unreadable rows, duplicates), logging / saving / both, label values onto an entry without overwriting, and the four ways
// into Add supplement. The nutrition API is mocked at the module edge; the photos are "shrunk" by a mock.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const m = vi.hoisted(() => ({
  sheets: [], downscale: vi.fn(), decode: vi.fn(), toast: vi.fn(),
  api: { getConfig: vi.fn(), readLabel: vi.fn(), createFood: vi.fn(), addEntries: vi.fn(), applyLabelMicros: vi.fn(), lookupBarcode: vi.fn(), searchSupplements: vi.fn(), getSupplementLabel: vi.fn(), listFoods: vi.fn(), getStack: vi.fn(), updateFood: vi.fn(), deleteFood: vi.fn(), updateEntry: vi.fn(), deleteEntry: vi.fn(), applyMicros: vi.fn(), matchMicros: vi.fn(), previewMicros: vi.fn(), searchFoods: vi.fn(), analyze: vi.fn(), putStack: vi.fn() }
}))
vi.mock('../store/useStore.js', () => { const snap = () => ({ user: { id: 'u1', admin: false }, S: { unit: 'kg' } }); const u = sel => (sel ? sel(snap()) : snap()); u.getState = snap; return { useStore: u } })
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: (...a) => m.toast(...a), openSheet: render => { m.sheets.push(render); return { id: 's', close: () => {} } } })
  const u = sel => (sel ? sel(snap()) : snap()); u.getState = snap; return { useUI: u }
})
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))
vi.mock('./api.js', () => m.api)
vi.mock('./image.js', () => ({ MAX_EDGE: 1280, downscaleToJpeg: (...a) => m.downscale(...a) }))
vi.mock('./barcode-decode.js', () => ({ decodeFile: (...a) => m.decode(...a) }))

const { default: LabelFlow } = await import('./LabelFlow.jsx')
const { default: SupplementAdd } = await import('./SupplementAdd.jsx')

let host, root
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const show = async ui => { await act(async () => { root.render(ui) }); await flush() }
const click = async el => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await flush() }
const byText = (sel, s) => { const all = [...host.querySelectorAll(sel)]; return all.find(e => e.textContent.trim() === s) || all.find(e => e.textContent.includes(s)) }
const setValue = async (el, v) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }) }
const pickFiles = async (input, files) => { Object.defineProperty(input, 'files', { value: files, configurable: true }); await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) }); await flush() }
const jpg = n => new File(['x'], n, { type: 'image/jpeg' })
const apiError = (message, status, data = {}) => Object.assign(new Error(message), { status, data, code: data.code })

const AI = { limit: 30, used: 4, remaining: 26, available: true }
const LABEL = {
  isLabel: true, name: 'Daily Multi', brand: 'Brightwell', servingText: '2 capsules', servingGrams: null, servingsPerContainer: 30, upc: '012345678905', kind: 'supplement', flags: [{ code: 'x', text: 'Calories do not match the macros.' }], otherIngredientsText: 'Gelatin, rice flour',
  columns: [
    { id: 0, heading: 'Per serving', perServing: true, grams: null, per: { calories: 5 }, micros: { vit_c_mg: 90, vit_d_mcg: 25 }, others: [{ name: 'Creatine', amount: 3, unit: 'g' }], rows: [{ name: 'Zinc', key: 'zinc_mg', flag: 'unreadable', amount: null, unit: 'mg' }], flags: [] },
    { id: 1, heading: 'As prepared', perServing: true, grams: 50, per: { calories: 80 }, micros: { vit_c_mg: 45 }, others: [], rows: [], flags: [] }]
}

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  m.sheets.length = 0
  for (const f of Object.values(m.api)) f.mockReset()
  m.toast.mockReset(); m.downscale.mockReset(); m.decode.mockReset()
  globalThis.URL.revokeObjectURL = globalThis.URL.revokeObjectURL || (() => {})
  m.api.getConfig.mockResolvedValue({ ai: AI })
  m.downscale.mockImplementation(async f => ({ base64: 'B64' + f.name, bytes: 300000, width: 1280, height: 960, previewUrl: 'blob:' + f.name }))
})
afterEach(() => { act(() => root.unmount()); host.remove() })

const flow = (props = {}) => show(<LabelFlow mode="food" date="2026-10-12" meal="lunch" onBack={vi.fn()} onSaved={vi.fn()} close={vi.fn()} {...props} />)
const inputs = () => [...host.querySelectorAll('input[type="file"]')]

describe('label photos on screen', () => {
  it('camera takes one photo, the library input takes several at once; thumbnails can be removed', async () => {
    await flow()
    const [camera, library] = inputs()
    expect(camera.getAttribute('capture')).toBe('environment'); expect(camera.multiple).toBe(false)
    expect(library.multiple).toBe(true); expect(library.getAttribute('capture')).toBeNull()
    await pickFiles(library, [jpg('a.jpg'), jpg('b.jpg'), jpg('c.jpg')])
    expect(m.downscale).toHaveBeenCalledTimes(3)
    expect(host.querySelectorAll('.nut-lab-thumb')).toHaveLength(3)
    expect(host.textContent).toContain('3 of 4 photos')
    await click(host.querySelector('[aria-label="Remove photo 2"]'))
    expect(host.querySelectorAll('.nut-lab-thumb')).toHaveLength(2)
    await pickFiles(camera, [jpg('d.jpg')])
    expect(host.querySelectorAll('.nut-lab-thumb')).toHaveLength(3)
  })

  it('a fifth photo is refused in words; photos too big together block the Read button and say why', async () => {
    await flow()
    const library = inputs()[1]
    await pickFiles(library, [1, 2, 3, 4, 5].map(i => jpg(i + '.jpg')))
    expect(host.querySelectorAll('.nut-lab-thumb')).toHaveLength(4)
    expect(host.textContent).toContain('Only 4 photos can be read at once; 1 left out')
    m.downscale.mockImplementation(async f => ({ base64: 'x', bytes: 1400000, previewUrl: 'blob:' + f.name }))
    for (let i = 0; i < 4; i++) await click(host.querySelector('[aria-label="Remove photo 1"]'))
    await pickFiles(library, [jpg('big1.jpg'), jpg('big2.jpg'), jpg('big3.jpg')])
    expect(host.textContent).toMatch(/too large to send together/)
    expect(byText('button', 'Read the label').disabled).toBe(true)
  })

  it('Read the label sends every photo in ONE request, the allowance is shown, and a "not a label" answer says so', async () => {
    m.api.readLabel.mockResolvedValue({ label: { isLabel: false }, ai: { ...AI, used: 5, remaining: 25 } })
    await flow()
    expect(host.textContent).toContain('AI analyses left today')
    expect(byText('button', 'Read the label').disabled).toBe(true)
    await pickFiles(inputs()[1], [jpg('a.jpg'), jpg('b.jpg')])
    await click(byText('button', 'Read the label'))
    expect(m.api.readLabel).toHaveBeenCalledTimes(1)
    expect(m.api.readLabel).toHaveBeenCalledWith(['B64a.jpg', 'B64b.jpg'], 'food')
    expect(host.textContent).toContain('does not look like a nutrition or supplement facts label')
  })

  it('no allowance left: the button is disabled and the reason is shown, nothing is sent', async () => {
    m.api.getConfig.mockResolvedValue({ ai: { ...AI, remaining: 0 } })
    await flow()
    await pickFiles(inputs()[1], [jpg('a.jpg')])
    expect(byText('button', 'Read the label').disabled).toBe(true)
    expect(host.textContent).toContain('used all of today’s AI analyses')
  })
})

describe('the review', () => {
  const toReview = async (props = {}, label = LABEL) => {
    m.api.readLabel.mockResolvedValue({ label, ai: AI })
    await show(null)
    await flow(props)
    await pickFiles(inputs()[1], [jpg('a.jpg')])
    await click(byText('button', 'Read the label'))
  }

  it('shows editable fields, the note, the unreadable row, the label’s own warning, and the column choice; saves nothing yet', async () => {
    await toReview({ mode: 'supplement' })
    expect(host.textContent).toContain('Read from your photo of the label, please check')
    expect(host.querySelector('input[aria-label="Name"]').value).toBe('Daily Multi')
    expect(host.querySelector('input[aria-label="Brand"]').value).toBe('Brightwell')
    expect(host.querySelector('input[aria-label="Barcode"]').value).toBe('012345678905')
    expect(host.querySelector('.nut-lab-check').textContent).toContain('Zinc')
    expect(host.textContent).toContain('Calories do not match the macros.')
    expect(host.textContent).toContain('Which one did you eat?')
    expect(host.querySelector('.nut-lab-other').textContent).toContain('Creatine')
    expect(m.api.createFood).not.toHaveBeenCalled(); expect(m.api.addEntries).not.toHaveBeenCalled()
    await click(byText('button', 'As prepared'))
    expect(host.querySelector('input[aria-label="Serving weight"]').value).toBe('50')
  })

  it('Save and add: saves to My supplements (origin label, barcode, other ingredients) then logs it by id', async () => {
    m.api.createFood.mockResolvedValue({ food: { id: 'f9' } }); m.api.addEntries.mockResolvedValue({})
    const onSaved = vi.fn(), close = vi.fn()
    await toReview({ mode: 'supplement', onSaved, close })
    await setValue(host.querySelector('input[aria-label="Name"]'), 'Daily Multi 2')
    await click(byText('button', 'Save and add'))
    const body = m.api.createFood.mock.calls[0][0]
    expect(body).toMatchObject({ name: 'Daily Multi 2', type: 'supplement', origin: 'label', upc: '012345678905', checkDuplicate: true })
    expect(body.micros).toEqual({ vit_c_mg: 90, vit_d_mcg: 25 })
    expect(body.otherIngredients).toEqual([{ name: 'Creatine', amount: 3, unit: 'g' }])
    expect(m.api.addEntries).toHaveBeenCalledWith({ date: '2026-10-12', meal: 'supplements', source: 'food', foodId: 'f9', qty: 1 })
    expect(onSaved).toHaveBeenCalled(); expect(close).toHaveBeenCalled()
  })

  it('Only add logs without saving; Only save does not log', async () => {
    m.api.addEntries.mockResolvedValue({}); m.api.createFood.mockResolvedValue({ food: { id: 'f1' } })
    await toReview({ mode: 'food' })
    await click(byText('button', 'Only add to lunch'))
    expect(m.api.createFood).not.toHaveBeenCalled()
    expect(m.api.addEntries.mock.calls[0][0]).toMatchObject({ meal: 'lunch', name: 'Daily Multi', micros: { vit_c_mg: 90, vit_d_mcg: 25 }, microsSource: 'label' })
    m.api.addEntries.mockClear()
    await toReview({ mode: 'food' })
    await click(byText('button', 'Only save to My foods'))
    expect(m.api.createFood).toHaveBeenCalledTimes(1); expect(m.api.addEntries).not.toHaveBeenCalled()
  })

  it('the same product already saved: three choices, and "Use the saved one" makes no second copy', async () => {
    const existing = { id: 'old1', name: 'Daily Multi', brand: 'Brightwell', serving: { label: '1 tab' } }
    m.api.createFood.mockRejectedValueOnce(apiError('exists', 409, { code: 'duplicate', existing })).mockResolvedValue({ food: { id: 'new' } })
    m.api.addEntries.mockResolvedValue({})
    await toReview({ mode: 'supplement' })
    await click(byText('button', 'Save and add'))
    expect(byText('button', 'Use the saved one')).toBeTruthy()
    expect(byText('button', 'Update the saved one with this label')).toBeTruthy()
    expect(byText('button', 'Save as a new one')).toBeTruthy()
    await click(byText('button', 'Use the saved one'))
    expect(m.api.createFood).toHaveBeenCalledTimes(1)
    expect(m.api.addEntries).toHaveBeenCalledWith(expect.objectContaining({ foodId: 'old1', meal: 'supplements' }))
  })

  it('"Save as a new one" and "Update" resend with the choice', async () => {
    const existing = { id: 'old1', name: 'Daily Multi', brand: 'Brightwell', serving: { label: '1 tab' } }
    m.api.createFood.mockRejectedValueOnce(apiError('exists', 409, { code: 'duplicate', existing })).mockResolvedValue({ food: { id: 'new' } })
    m.api.addEntries.mockResolvedValue({})
    await toReview({ mode: 'supplement' })
    await click(byText('button', 'Save and add'))
    await click(byText('button', 'Update the saved one with this label'))
    expect(m.api.createFood.mock.calls[1][0].onDuplicate).toBe('update')
  })

  it('for an entry: label values are added as its own data, kept values are not replaced unless Replace is ticked', async () => {
    m.api.applyLabelMicros.mockResolvedValue({ entry: {} })
    const entry = { id: 'e1', name: 'Smoothie', qty: 1, micros: { vit_c_mg: 10 } }
    const onApplied = vi.fn()
    await toReview({ mode: 'entry', entry, onApplied })
    expect(host.textContent).toContain('already has different amounts')
    await click(byText('button', 'Add to this entry'))
    expect(m.api.applyLabelMicros).toHaveBeenCalledWith('2026-10-12', 'e1', { micros: { vit_c_mg: 90, vit_d_mcg: 25 }, overwrite: [] })
    expect(onApplied).toHaveBeenCalled()
    m.api.applyLabelMicros.mockClear()
    await toReview({ mode: 'entry', entry, onApplied })
    await click(host.querySelector('.nut-lab-replace input'))
    await click(byText('button', 'Add to this entry'))
    expect(m.api.applyLabelMicros.mock.calls[0][2].overwrite).toEqual(['vit_c_mg'])
  })

  it('fill mode hands the edited values back and saves nothing', async () => {
    const onUse = vi.fn()
    await toReview({ mode: 'fill', onUse })
    await click(byText('button', 'Use these values'))
    expect(onUse.mock.calls[0][0]).toMatchObject({ name: 'Daily Multi', upc: '012345678905' })
    expect(m.api.createFood).not.toHaveBeenCalled(); expect(m.api.addEntries).not.toHaveBeenCalled()
  })

  it('an error from the server is shown with its words and the allowance, and Read can be tried again', async () => {
    m.api.readLabel.mockRejectedValue(apiError('The AI could not read that.', 502, { ai: { ...AI, remaining: 26 } }))
    await flow()
    await pickFiles(inputs()[1], [jpg('a.jpg')])
    await click(byText('button', 'Read the label'))
    expect(host.textContent).toContain('The AI could not read that.')
    expect(byText('button', 'Read the label').disabled).toBe(false)
  })
})

describe('Add supplement: four ways in', () => {
  const sheet = () => show(<SupplementAdd date="2026-10-12" onDone={vi.fn()} close={vi.fn()} manual={<div>MANUAL FORM</div>} />)
  const HIT = { source: 'dsld', kind: 'supplement', ext: '77', name: 'Vitamin D3 2000 IU', brand: 'Brightwell', upc: '012345678905', bases: [{ label: '1 softgel', grams: null, per: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 }, micros: { vit_d_mcg: 50 } }], otherIngredients: [{ name: 'Olive oil', amount: null, unit: '' }] }

  it('offers Scan barcode, Photo of the label, Search and Manual', async () => {
    await sheet()
    for (const t of ['Scan barcode', 'Photo of the label', 'Search', 'Manual']) expect(byText('button', t)).toBeTruthy()
    await click(byText('button', 'Manual'))
    expect(host.textContent).toContain('MANUAL FORM')
  })

  it('a typed barcode is asked as kind supplement; an NIH hit goes through the review with the NIH attribution', async () => {
    m.api.lookupBarcode.mockResolvedValue({ code: '012345678905', found: true, via: 'dsld', product: HIT })
    await sheet()
    await click(byText('button', 'Scan barcode'))
    const typed = host.querySelector('input[inputmode="numeric"]')
    await setValue(typed, '012345678905')
    await click(byText('button', 'Look up') || byText('button', 'Use this number') || [...host.querySelectorAll('button')].find(b => /look|use|go/i.test(b.textContent)))
    expect(m.api.lookupBarcode).toHaveBeenCalledWith('012345678905', 'supplement')
    expect(host.textContent).toContain('NIH Office of Dietary Supplements')
    await click(byText('button', 'Check and add it'))
    expect(host.querySelector('input[aria-label="Name"]').value).toBe('Vitamin D3 2000 IU')
    expect(host.textContent).toContain('From the NIH Dietary Supplement Label Database')
    expect(host.querySelector('.nut-lab-other').textContent).toContain('Olive oil')
  })

  it('a supplement already saved with that barcode is offered first, to log in one step', async () => {
    m.api.lookupBarcode.mockResolvedValue({ code: '012345678905', found: true, via: 'mine', product: { ...HIT, source: 'mine', ext: 'f5' } })
    m.api.addEntries.mockResolvedValue({})
    await sheet()
    await click(byText('button', 'Scan barcode'))
    await setValue(host.querySelector('input[inputmode="numeric"]'), '012345678905')
    await click([...host.querySelectorAll('button')].find(b => /look|use|go/i.test(b.textContent)))
    expect(host.textContent).toContain('You already saved this one')
    await click(byText('button', 'Add to supplements'))
    expect(m.api.addEntries).toHaveBeenCalledWith({ date: '2026-10-12', meal: 'supplements', source: 'food', foodId: 'f5', qty: 1 })
  })

  it('nothing found anywhere: says so and offers to photograph the label, keeping the barcode', async () => {
    m.api.lookupBarcode.mockResolvedValue({ code: '012345678905', found: false, reason: 'unknown', tried: [] })
    m.api.readLabel.mockResolvedValue({ label: { ...LABEL, upc: '' }, ai: AI })
    await sheet()
    await click(byText('button', 'Scan barcode'))
    await setValue(host.querySelector('input[inputmode="numeric"]'), '012345678905')
    await click([...host.querySelectorAll('button')].find(b => /look|use|go/i.test(b.textContent)))
    await click(byText('button', 'Photograph the label instead'))
    expect(host.textContent).toContain('Barcode: 012345678905')
  })

  it('NIH answered with similar products but not this barcode: the note is shown with the photo option', async () => {
    m.api.lookupBarcode.mockResolvedValue({ code: '031604026974', found: false, reason: 'unknown', tried: [{ source: 'dsld', ok: true, found: false, note: 'NIH has similar products but not this barcode.' }] })
    await sheet()
    await click(byText('button', 'Scan barcode'))
    await setValue(host.querySelector('input[inputmode="numeric"]'), '031604026974')
    await click([...host.querySelectorAll('button')].find(b => /look|use|go/i.test(b.textContent)))
    expect(host.textContent).toContain('NIH has similar products but not this barcode.')
    expect(byText('button', 'Photograph the label instead')).toBeTruthy()
  })

  it('Search by name: results with the NIH credit, one label opens in the review', async () => {
    m.api.searchSupplements.mockResolvedValue({ results: [{ id: '77', name: 'Vitamin D3 2000 IU', brand: 'Brightwell', offMarket: false }, { id: '78', name: 'Vitamin D3 old', brand: 'Brightwell', offMarket: true }] })
    m.api.getSupplementLabel.mockResolvedValue({ product: HIT })
    await sheet()
    await click(byText('button', 'Search'))
    await setValue(host.querySelector('input[type="search"], input[placeholder="Brand or product name"]'), 'vitamin d3')
    await click(byText('button', 'Search', ))
    expect(host.textContent).toContain('off the market')
    expect(host.textContent).toContain('Public domain')
    await click(host.querySelector('.nut-pick'))
    expect(m.api.getSupplementLabel).toHaveBeenCalledWith('77')
    expect(host.querySelector('input[aria-label="Name"]').value).toBe('Vitamin D3 2000 IU')
  })
})
