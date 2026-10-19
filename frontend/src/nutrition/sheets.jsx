// The bottom sheets of the diary: add (quick or from a food), edit an entry, edit a food.
// Opened through useUI().openSheet like every other sheet in the app; each takes `close` and
// calls `onSaved` after the server has accepted the change, so the screen behind reloads.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { Button, NumberField, SearchField, Segmented, SelectRow, Stepper, TextField } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { confirmSheet } from '../sheets.jsx'
import { useStore } from '../store/useStore.js'
import { MOBILE } from '../lib/mobile.js'
import { scanCode } from '../lib/scan.js'
import BarcodeScanner from './BarcodeScanner.jsx'
import AiLog from './AiLog.jsx'
import { allowanceText, unavailableText } from './ai.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { GROUPS, NUTRIENTS, cleanMicros, hasMicros, scaleMicros } from './micros.js'
import { MACRO_LABEL, MEALS, MEAL_LABEL, amountPatch, entryBase, foodBody, foodFromEntry, gramsForQty, macroLine, qtyForGramsOf, quickBody, savedFoodBody, scaleEntry, scaleFood, trim } from './diary.js'
import { FATSECRET_CREDIT, FATSECRET_URL, NO_RETRY, SOURCE_LABEL, SOURCE_SHORT, barcodeOf, defaultBase, gramsOf, hitLine, qtyForGrams, snapshotOf, sourceNotes } from './lookup.js'
import { NO_CODE_TEXT, gtinCheckOk, lookupCode, scanMethods } from './barcode.js'
import * as finder from './search.js'

const toast = m => useUI.getState().toast(m)
// "A and B", "A, B and C"
const andList = names => (names.length > 2 ? names.slice(0, -1).join(', ') + ' ' + nt('and') + ' ' + names.at(-1) : names.join(' ' + nt('and') + ' '))
const fail = e => toast(e?.message || nt('Something went wrong'))
const mealOptions = () => MEALS.map(m => ({ value: m, label: nt(MEAL_LABEL[m]) }))

/** The four macro inputs, in a 2×2 grid. `v` is { calories, protein_g, carbs_g, fat_g } of number|null. */
export function MacroFields({ v, set, disabled, caloriesLabel = 'Calories' }) {
  const cell = (k, label, unit) => <label className="nut-field" key={k}>
    <span>{nt(label)}</span>
    <span className="nut-input"><NumberField nullable value={v[k]} disabled={disabled} onChange={n => set({ ...v, [k]: n })} aria-label={nt(label)} /><i>{unit}</i></span>
  </label>
  return <div className="nut-fields">
    {cell('calories', caloriesLabel, 'kcal')}{cell('protein_g', 'Protein', 'g')}{cell('carbs_g', 'Carbs', 'g')}{cell('fat_g', 'Fat', 'g')}
  </div>
}

/**
 * "More nutrients": the micronutrients from a label, collapsed until asked for. `v` holds the typed amounts (number, or
 * null / missing = not known); an empty box means unknown and is never sent as 0. Amounts are per serving in a food form
 * and for the whole entry in the Edit entry sheet.
 */
export function MoreNutrients({ v, set, disabled = false, note }) {
  const [open, setOpen] = useState(false)
  const filled = Object.keys(cleanMicros(v)).length
  return <div className="nut-more">
    <button type="button" className="nut-more-h" onClick={() => setOpen(o => !o)} aria-expanded={open}>
      <span>{nt('More nutrients')}{filled > 0 && <span className="muted small"> · {nt('{0} filled in', filled)}</span>}</span>
      <Icon name={open ? 'chevronUp' : 'chevronDown'} />
    </button>
    {open && <div className="nut-more-b">
      <div className="muted small nut-more-note">{note || nt('Vitamins and minerals from the label. Leave a box empty if the label does not say: that stays unknown, not 0.')}</div>
      {GROUPS.map(g => <div key={g.id}>
        <div className="nut-section-t">{nt(g.label)}</div>
        <div className="nut-fields">
          {NUTRIENTS.filter(n => n.group === g.id).map(n => <label className="nut-field" key={n.key}>
            <span>{nt(n.label)}</span>
            <span className="nut-input"><NumberField nullable value={v?.[n.key] ?? null} disabled={disabled} onChange={x => set({ ...v, [n.key]: x })} aria-label={nt(n.label)} /><i>{n.unit}</i></span>
          </label>)}
        </div>
      </div>)}
    </div>}
  </div>
}

/* ------------------------------ save as a reusable food ------------------------------ */

/**
 * The fields of a food to save: name, optional brand, the serving's label and weight, and the numbers for ONE serving.
 * Controlled; `v` is { name, brand, serving, grams, calories, protein_g, carbs_g, fat_g }.
 */
export function SaveFoodFields({ v, set }) {
  const macros = { calories: v.calories, protein_g: v.protein_g, carbs_g: v.carbs_g, fat_g: v.fat_g }
  return <div className="nut-savefields">
    <TextField value={v.name} maxLength={120} placeholder={nt('Name, e.g. Pliny the Elder, 12 oz can')} onChange={e => set({ ...v, name: e.target.value })} aria-label={nt('Saved food name')} />
    <div style={{ height: 8 }} />
    <TextField value={v.brand} maxLength={60} placeholder={nt('Brand (optional)')} onChange={e => set({ ...v, brand: e.target.value })} aria-label={nt('Saved food brand')} />
    <div className="nut-section-t">{nt('One serving')}</div>
    <div className="nut-fields">
      <label className="nut-field"><span>{nt('Serving')}</span><span className="nut-input"><TextField value={v.serving} maxLength={60} placeholder={nt('e.g. 1 can (12 oz)')} onChange={e => set({ ...v, serving: e.target.value })} aria-label={nt('Saved serving')} /></span></label>
      <label className="nut-field"><span>{nt('Weight')}</span><span className="nut-input"><NumberField nullable value={v.grams} onChange={n => set({ ...v, grams: n })} aria-label={nt('Saved serving weight')} /><i>g</i></span></label>
    </div>
    <div style={{ height: 8 }} />
    <MacroFields v={macros} set={m => set({ ...v, ...m })} />
  </div>
}

/** Already saved under this name and brand: the two honest choices, inline (no popup). */
export function DuplicateChoice({ existing, onChoose, busy = false }) {
  return <div className="nut-banner warn nut-dup" role="alert">
    <Icon name="warning" />
    <span>{nt('You already have “{0}” saved ({1}, {2} kcal).', existing.name, existing.serving?.label || nt('1 serving'), existing.per?.calories ?? '?')}</span>
    <div className="nut-dup-actions">
      <Button size="sm" onClick={() => onChoose('update')} disabled={busy}>{nt('Update the saved food')}</Button>
      <Button size="sm" onClick={() => onChoose('new')} disabled={busy}>{nt('Save as a new one')}</Button>
    </div>
  </div>
}

function SaveFoodSheet({ initial, onSaved, close }) {
  const [f, setF] = useState({ name: initial.name, brand: initial.brand || '', serving: initial.serving || '', grams: initial.grams ?? null, calories: initial.calories, protein_g: initial.protein_g, carbs_g: initial.carbs_g, fat_g: initial.fat_g })
  const [dup, setDup] = useState(null)
  const [busy, setBusy] = useState(false)
  const [mi, setMi] = useState(initial.micros || {})
  const save = async choice => {
    const r = savedFoodBody({ ...f, origin: initial.origin, ...(hasMicros(cleanMicros(mi)) ? { micros: mi } : {}) }, { choice })
    if (!r.ok) { toast(nt(r.error)); return }
    setBusy(true)
    try {
      const out = await nutri.createFood(r.body)
      onSaved?.(out.food); close(); toast(out.updated ? nt('Saved food updated') : nt('Saved to My foods'))
    } catch (e) {
      if (e.status === 409 && e.data?.code === 'duplicate') { setDup(e.data.existing); setBusy(false); return }
      fail(e); setBusy(false)
    }
  }
  return <>
    <h3>{nt('Save as a food')}</h3>
    <div className="muted small" style={{ margin: '0 0 10px' }}>
      {initial.origin === 'ai' ? nt('An AI estimate you confirmed. Only this name and these numbers are saved, never the photo. ') : ''}{nt('Next time, tap it in Add and log it with the servings stepper.')}
    </div>
    <SaveFoodFields v={f} set={nv => { setF(nv); setDup(null) }} />
    <MoreNutrients v={mi} set={nv => { setMi(nv); setDup(null) }} />
    {dup && <><div style={{ height: 10 }} /><DuplicateChoice existing={dup} onChoose={save} busy={busy} /></>}
    <div style={{ height: 14 }} />
    {!dup && <Button variant="primary" onClick={() => save(null)} disabled={busy}>{nt('Save to My foods')}</Button>}
    <div style={{ height: 4 }} />
    <Button variant="ghost" className="dim" onClick={close}>{nt('Cancel')}</Button>
  </>
}

/** Open the Save-as-a-food sheet for `initial` (see diary.js foodFromEntry). `onSaved(food)` runs after the server accepted it. */
export const openSaveFood = props => useUI.getState().openSheet(close => <SaveFoodSheet {...props} close={close} />)

/* ------------------------------ add to a meal ------------------------------ */

function QuickAdd({ date, meal, initialName = '', onSaved, close }) {
  const [name, setName] = useState(initialName)
  const [m, setM] = useState({ calories: null, protein_g: null, carbs_g: null, fat_g: null })
  const [mi, setMi] = useState({})
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const r = quickBody({ name, meal, ...m }, date)
    if (!r.ok) { toast(nt(r.error)); return }
    // Only micronutrients typed in are sent; a quick add never has guessed ones.
    const typed = cleanMicros(mi)
    setBusy(true)
    try { await nutri.addEntries(hasMicros(typed) ? { ...r.body, micros: typed } : r.body); onSaved(); close(); toast(nt('Added')) } catch (e) { fail(e); setBusy(false) }
  }
  return <>
    <TextField value={name} maxLength={120} placeholder={nt('Name (optional)')} onChange={e => setName(e.target.value)} aria-label={nt('Name')} />
    <div style={{ height: 10 }} />
    <MacroFields v={m} set={setM} />
    <MoreNutrients v={mi} set={setMi} />
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={save} disabled={busy}>{nt('Add to {0}', nt(MEAL_LABEL[meal]).toLowerCase())}</Button>
  </>
}

/** The credit FatSecret's terms require wherever their results are shown. */
export function FatSecretCredit() {
  return <a className="nut-credit" href={FATSECRET_URL} target="_blank" rel="noopener noreferrer">{nt(FATSECRET_CREDIT)}</a>
}

/* One portion chooser for every kind of food: my own, a recent, a search hit, a scanned product.
   `bases` are the ways the food can be measured; the amount is shown as servings AND, where the
   base has a weight, as grams, and the two stay in step. */
function Portion({ name, brand, bases, meal, onBack, onAdd, busy, tag, credit = false }) {
  const [bi, setBi] = useState(0)
  const [qty, setQty] = useState(1)
  const base = bases[bi]
  const grams = gramsOf(base, qty)
  const s = scaleFood({ per: base.per, serving: { grams: base.grams } }, qty)
  const pickBase = i => {
    const g = gramsOf(base, qty)
    setBi(i)
    setQty(g && bases[i].grams ? qtyForGrams(bases[i], g) || 1 : 1)
  }
  return <>
    <button className="nut-back" onClick={onBack}><Icon name="chevronLeft" />{nt('Back')}</button>
    <div className="nut-picked"><b>{name}</b>{brand && <span className="muted"> · {brand}</span>}{tag && <span className="tag nut-src">{tag}</span>}</div>
    {bases.length > 1
      ? <SelectRow title={nt('Portion')} sheetTitle={nt('Portion')} value={bi} onChange={pickBase} options={bases.map((b, i) => ({ value: i, label: b.label }))} />
      : <div className="muted small">{nt('One serving: {0}', base.label)}</div>}
    <div className="row between" style={{ margin: '12px 0 8px' }}>
      <span>{nt('Servings')}</span>
      <Stepper value={qty} step={base.grams === 100 ? 0.25 : 0.5} min={0.01} max={1000} onChange={setQty} ariaLabel={nt('Servings')} />
    </div>
    {grams != null && <label className="nut-datefield" style={{ marginTop: 0, marginBottom: 12 }}>
      <span>{nt('Weight')}</span>
      <span className="nut-input nut-cap"><NumberField value={grams} onChange={g => { const q = qtyForGrams(base, g); if (q) setQty(q) }} aria-label={nt('Weight in grams')} /><i>g</i></span>
    </label>}
    <div className="nut-preview"><b>{s.calories}</b> kcal<span className="muted"> · {macroLine(s)}</span></div>
    {credit && <div className="nut-credit-row"><FatSecretCredit /></div>}
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={() => onAdd(qty, base)} disabled={busy}>{nt('Add to {0}', nt(MEAL_LABEL[meal]).toLowerCase())}</Button>
  </>
}

const basesOfFood = f => [{ label: f.serving.label, grams: f.serving.grams, per: f.per }]
const tagOfFood = f => (f.source === 'off' || f.source === 'usda' || f.source === 'fatsecret' ? SOURCE_SHORT[f.source] : f.origin === 'ai' ? 'AI estimate' : null)

function FoodPick({ date, meal, onSaved, close }) {
  const [scope, setScope] = useState('recent')
  const [text, setText] = useState('')
  const [foods, setFoods] = useState(null)
  const [picked, setPicked] = useState(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  const load = () => {
    const n = ++seq.current
    nutri.listFoods(scope, text).then(r => { if (n === seq.current) setFoods(r.foods) }).catch(e => { if (n === seq.current) { setFoods([]); fail(e) } })
  }
  useEffect(() => { const id = setTimeout(load, text ? 200 : 0); return () => clearTimeout(id) }, [scope, text])

  const add = async qty => {
    setBusy(true)
    try {
      await nutri.addEntries({ date, meal, source: 'food', foodId: picked.id, qty })
      onSaved(); close(); toast(nt('Added'))
    } catch (e) { fail(e); setBusy(false) }
  }

  if (picked) return <Portion name={picked.name} brand={picked.brand} bases={basesOfFood(picked)} meal={meal} tag={tagOfFood(picked)} credit={picked.source === 'fatsecret'} busy={busy} onBack={() => setPicked(null)} onAdd={add} />

  return <>
    <Segmented value={scope} onChange={setScope} options={[{ value: 'recent', label: nt('Recent') }, { value: 'favorite', label: nt('Favourites') }, { value: 'all', label: nt('All') }]} />
    <div style={{ height: 10 }} />
    <SearchField value={text} onChange={e => setText(e.target.value)} onClear={() => setText('')} placeholder={nt('Search my foods')} />
    <div className="nut-pick-list">
      {foods === null && <div className="muted small nut-empty">{nt('Loading…')}</div>}
      {foods?.length === 0 && <div className="muted small nut-empty">
        {scope === 'recent' ? nt('Foods you log appear here.') : nt('No foods yet.')}
        <div style={{ marginTop: 10 }}><Button size="sm" icon="plus" onClick={() => openFoodSheet({ onSaved: load })}>{nt('Create a food')}</Button></div>
      </div>}
      {foods?.map(f => <button key={f.id} className="nut-pick" onClick={() => setPicked(f)}>
        <span className="nut-pick-m"><span className="nut-pick-t">{f.name}</span><span className="nut-pick-s">{f.brand ? f.brand + ' · ' : ''}{f.serving.label} · {macroLine(f.per)}</span></span>
        <span className="nut-pick-r"><span className="nut-kcal">{f.per.calories}</span>{f.origin === 'ai' && <span className="tag nut-src">{nt('AI estimate')}</span>}</span>
      </button>)}
    </div>
  </>
}

/* ------------------------------ search & barcode ------------------------------ */

function HitRow({ hit, onPick }) {
  const b = defaultBase(hit)
  return <button className="nut-pick" onClick={() => onPick(hit)}>
    <span className="nut-pick-m"><span className="nut-pick-t">{hit.name}</span><span className="nut-pick-s">{hitLine(hit)} · {macroLine(b.per)}</span></span>
    <span className="nut-pick-r"><span className="nut-kcal">{b.per.calories}</span><span className="tag nut-src">{nt(SOURCE_SHORT[hit.source])}</span>{hit.origin === 'ai' && <span className="tag nut-src">{nt('AI estimate')}</span>}</span>
  </button>
}

/* The barcode panel. Order of preference, on every device: a PHOTO of the barcode through the
   phone's own camera (always works, and is read in the page); the live viewfinder where the
   browser or app has one (an extra); and typing the number (always there). */
function ScanPanel({ methods, onCode, onTyped }) {
  const [live, setLive] = useState(false)
  const [state, setState] = useState({ status: 'idle', message: '' })    // idle | reading | none | error
  const [liveFail, setLiveFail] = useState('')
  const [code, setCode] = useState('')
  const camera = useRef(null)
  const gallery = useRef(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const choose = async file => {
    if (!file) return
    setState({ status: 'reading', message: '' }); setLiveFail('')
    // Lazy: the decoder (a megabyte of WebAssembly) is fetched only now, the first time it is needed.
    const { decodeFile } = await import('./barcode-decode.js')
    const r = await decodeFile(file)
    if (!alive.current) return
    if (r.ok) { setState({ status: 'idle', message: '' }); onCode(r.code, 'photo'); return }
    setState({ status: r.reason === 'none' ? 'none' : 'error', message: r.reason === 'none' ? NO_CODE_TEXT : r.message })
  }
  const startLive = async () => {
    setLiveFail('')
    if (methods.live === 'native') {
      try { const r = await scanCode(); const c = r?.value && lookupCode(r.value); if (c) onCode(c, 'live') } catch (e) { setLiveFail(nt('The app’s scanner could not start: {0}', e?.message || e)) }
    } else setLive(true)
  }
  const onFound = useCallback(c => { setLive(false); onCode(c, 'live') }, [onCode])

  if (live) return <BarcodeScanner onFound={onFound} onCancel={() => setLive(false)} onError={text => setLiveFail(text)} />

  return <div className="nut-scan">
    <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} />
    <input ref={gallery} type="file" accept="image/*" hidden onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} />
    <Button variant="primary" icon="camera" onClick={() => camera.current?.click()} disabled={state.status === 'reading'}>
      {state.status === 'none' || state.status === 'error' ? nt('Retake the photo') : nt('Take a photo of the barcode')}
    </Button>
    <div className="row" style={{ gap: 8, marginTop: 8 }}>
      <Button size="sm" icon="image" style={{ flex: 1 }} onClick={() => gallery.current?.click()} disabled={state.status === 'reading'}>{nt('Choose a photo')}</Button>
      {methods.live && <Button size="sm" icon="qr" style={{ flex: 1 }} onClick={startLive}>{nt('Live scan')}</Button>}
    </div>
    {state.status === 'reading' && <div className="nut-banner info"><span>{nt('Reading the barcode…')}</span></div>}
    {(state.status === 'none' || state.status === 'error') && <div className="nut-banner warn"><Icon name="warning" /><span>{nt(state.message)}</span></div>}
    {liveFail && <div className="nut-banner warn"><Icon name="warning" /><span>{nt('Live scan did not start. {0}', liveFail)}</span></div>}
    {!methods.live && methods.liveWhy && state.status === 'idle' && !liveFail && <div className="muted small nut-livewhy">{nt(methods.liveWhy)}</div>}
    <div className="muted small nut-livewhy">{state.status === 'idle' ? nt('Tip: fill the frame with the barcode and keep it sharp.') : ''}</div>
    <div className="nut-barcode">
      <div className="muted small" style={{ marginBottom: 6 }}>{nt('Or type the number printed under the barcode')}</div>
      <div className="row" style={{ gap: 8 }}>
        <input className="field" inputMode="numeric" placeholder={nt('Barcode number')} value={code} maxLength={20} onChange={e => setCode(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') onTyped(code) }} aria-label={nt('Barcode number')} />
        <Button onClick={() => onTyped(code)}>{nt('Look up')}</Button>
      </div>
    </div>
  </div>
}

/* What a search shows, always with a reason: results as they arrive, a line for anything still
   loading, a named failure with its own Retry, the note that USDA is off, and — only when every
   source really answered with nothing — "nothing found" with the ways to log it anyway. */
function SearchResults({ per, q, slow, isAdmin, ai, onPick, onRetry, onDescribe, onQuick }) {
  const v = finder.view(per)
  const loadingOutside = v.loading.filter(id => id !== 'mine')           // the person's own foods answer at once; the spinner is about the outside sources
  const aiOk = !!ai && ai.available && ai.remaining > 0
  const info = sourceNotes(Object.fromEntries(v.skipped.map(id => [id, { ok: false, skipped: per[id].why }])), { admin: isAdmin })
  const ways = <div className="nut-ways">
    <Button size="sm" icon="sparkles" onClick={onDescribe} disabled={!aiOk}>{nt('Describe it (AI)')}</Button>
    <Button size="sm" icon="plus" onClick={onQuick}>{nt('Quick add')}</Button>
    {!aiOk && ai && <div className="muted small">{nt(ai.available ? 'No AI analyses left today.' : unavailableText(ai.reason))}</div>}
  </div>
  return <>
    {v.errors.map(e => <div key={e.id} className="nut-banner warn" role="alert">
      <Icon name="warning" /><span>{nt(e.error)}</span>
      {!NO_RETRY.has(e.kind) && <button className="linkbtn" onClick={() => onRetry(e.id)}>{nt('Retry')}</button>}
    </div>)}
    {info.map((n, i) => <div key={i} className={'nut-banner ' + n.tone}><Icon name="info" /><span>{nt(n.text)}</span></div>)}
    {v.fatsecretOnly && <div className="nut-banner info"><Icon name="info" /><span>{nt('Nothing relevant in Open Food Facts or USDA. These are from FatSecret (restaurant, chain and store foods).')}</span></div>}
    {v.results.length > 0 && <div className={'nut-pick-list' + (v.loading.length ? ' stale' : '')}>
      {v.results.map(h => <HitRow key={h.source + h.ext + h.bases[0].label} hit={h} onPick={onPick} />)}
    </div>}
    {v.results.some(h => h.source === 'fatsecret') && <div className="nut-credit-row"><FatSecretCredit /></div>}
    {loadingOutside.length > 0 && <div className="nut-searching" role="status">
      <div className="nut-spinner sm" aria-hidden="true" />
      <span>{nt(slow ? (loadingOutside.length > 1 ? '{0} are slow right now — still waiting…' : '{0} is slow right now — still waiting…') : 'Searching {0}…', andList(loadingOutside.map(id => finder.NAME[id])))}</span>
    </div>}
    {v.nothingFound && <div className="nut-nothing">
      <div>{nt('Nothing found for “{0}”.', q)}</div>
      <div className="muted small">{nt('Try one simple word (“egg”, not “whole egg”), or log it another way:')}</div>
      {ways}
    </div>}
    {v.cannotTell && <div className="nut-nothing">
      <div>{nt('The search could not finish, so there is nothing to show yet.')}</div>
      <div className="muted small">{nt('Retry above, or log it another way:')}</div>
      {ways}
    </div>}
  </>
}

function SearchTab({ date, meal, ai, onSaved, onDescribe, onQuick, close }) {
  const isAdmin = useStore(s => !!s.user?.admin)
  const [text, setText] = useState('')
  const [per, setPer] = useState(null)           // null: nothing searched yet; else one status per source (search.js)
  const [slow, setSlow] = useState(false)
  const [picked, setPicked] = useState(null)
  const [busy, setBusy] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const [methods, setMethods] = useState({ photo: true, type: true, live: null, liveWhy: null })
  const [bc, setBc] = useState(null)             // { status, result, code, warn }
  const seq = useRef(0)
  const asked = useRef('')

  useEffect(() => { let live = true; scanMethods({ mobile: MOBILE }).then(m => live && setMethods(m)); return () => { live = false } }, [])

  // Both sources are asked at once and shown as each lands; a retry asks only the one that failed.
  const search = (query, ids) => {
    const id = ids ? seq.current : ++seq.current
    asked.current = query
    if (!ids) setPer(finder.fresh())
    setSlow(false)
    finder.run(query, {
      fetchSource: (q, source) => nutri.searchFoods(q, source),
      onSource: (src, status) => setPer(p => ({ ...(p || finder.fresh()), [src]: status })),
      ids: ids || finder.SOURCES,
      stale: () => id !== seq.current
    })
  }
  useEffect(() => {
    const q = text.trim()
    if (q.length < 2) { seq.current++; setPer(null); return }
    const id = setTimeout(() => search(q), 450)
    return () => clearTimeout(id)
  }, [text])
  // After a few seconds of waiting, say that a source is slow rather than leave a spinner unexplained.
  const waiting = per ? finder.view(per).loading : []
  useEffect(() => {
    if (!waiting.length) { setSlow(false); return }
    const id = setTimeout(() => setSlow(true), 6000)
    return () => clearTimeout(id)
  }, [waiting.join(',')])

  // A code from a photo, the live scanner or the keyboard. Look it up straight away.
  const lookup = async raw => {
    const c = barcodeOf(raw)
    if (!c) { toast(nt('A barcode is 8 to 14 digits.')); return }
    const warn = !gtinCheckOk(c)
    setScanOpen(false); setBc({ status: 'loading' })
    try { setBc({ status: 'done', result: await nutri.lookupBarcode(c), code: c, warn }) }
    catch (e) { setBc({ status: 'error', error: e.status === 429 ? nt('Too many lookups — wait a moment and try again.') : e.message, code: c }) }
  }
  const onCode = useCallback(c => lookup(c), [])

  const add = async (qty, base) => {
    setBusy(true)
    try {
      // One of the person's own saved foods is logged by its id, like from My foods: no snapshot, no lookup, no AI.
      await nutri.addEntries(picked.source === 'mine' ? { date, meal, source: 'food', foodId: picked.ext, qty } : { date, meal, source: 'food', qty, food: snapshotOf(picked, base) })
      onSaved(); close(); toast(nt('Added'))
    } catch (e) { fail(e); setBusy(false) }
  }

  if (picked) return <Portion name={picked.name} brand={picked.brand} bases={picked.bases} meal={meal} tag={picked.origin === 'ai' ? nt('AI estimate') : SOURCE_LABEL[picked.source]} credit={picked.source === 'fatsecret'} busy={busy} onBack={() => setPicked(null)} onAdd={add} />

  const r = bc?.result
  return <>
    <div className="row" style={{ gap: 8 }}>
      <div style={{ flex: 1 }}><SearchField value={text} onChange={e => setText(e.target.value)} onClear={() => setText('')} placeholder={nt('Search foods')} onKeyDown={e => { if (e.key === 'Enter' && text.trim().length >= 2) run(text.trim()) }} /></div>
      <button className={'iconbtn' + (scanOpen ? ' on' : '')} onClick={() => setScanOpen(o => !o)} aria-label={nt('Scan a barcode')} aria-expanded={scanOpen}><Icon name="qr" /></button>
    </div>
    {scanOpen && <ScanPanel methods={methods} onCode={onCode} onTyped={lookup} />}

    {bc?.status === 'loading' && <div className="muted small nut-empty">{nt('Looking up the barcode…')}</div>}
    {bc?.status === 'error' && <div className="nut-banner warn"><Icon name="warning" /><span>{bc.error}</span><button className="linkbtn" onClick={() => lookup(bc.code)}>{nt('Try again')}</button></div>}
    {r?.found && <div className="nut-pick-list"><HitRow hit={r.product} onPick={setPicked} /></div>}
    {r?.found && r.product.source === 'fatsecret' && <div className="nut-credit-row"><FatSecretCredit /></div>}
    {r && !r.found && r.fatsecret?.error && <div className="nut-banner warn" role="alert"><Icon name="warning" /><span>{nt(r.fatsecret.error)}</span>{!NO_RETRY.has(r.fatsecret.kind) && <button className="linkbtn" onClick={() => lookup(bc.code)}>{nt('Retry')}</button>}</div>}
    {r && !r.found && <div className="nut-banner info">
      <Icon name="info" />
      <span>{r.reason === 'error' ? nt(r.error) : r.reason === 'no-nutrition' ? nt('“{0}” is in Open Food Facts but has no nutrition data.', r.name) : (r.fatsecret?.ok ? nt('Barcode {0} is not in Open Food Facts or FatSecret.', bc.code) : nt('Barcode {0} is not in Open Food Facts.', bc.code))}{bc.warn && r.reason !== 'error' ? ' ' + nt('Its check digit does not add up, so look for a typo.') : ''}</span>
      {r.reason === 'error'
        ? <button className="linkbtn" onClick={() => lookup(bc.code)}>{nt('Try again')}</button>
        : <button className="linkbtn" onClick={() => openFoodSheet({ prefill: { name: r.name || '', ext: bc.code }, onSaved: () => { onSaved(); close() } })}>{nt('Add it as my food')}</button>}
    </div>}

    {per && <SearchResults per={per} q={asked.current || text.trim()} slow={slow} isAdmin={isAdmin} ai={ai}
      onPick={setPicked} onRetry={id => search(asked.current, [id])} onDescribe={() => onDescribe(text.trim())} onQuick={() => onQuick(text.trim())} />}
    {!per && !bc && !scanOpen && <div className="muted small nut-empty">{nt('Search Open Food Facts, USDA and FatSecret, or scan a barcode.')}</div>}
  </>
}

function AddSheet({ date, meal: initial, onSaved, close }) {
  const [meal, setMeal] = useState(initial)
  const [tab, setTab] = useState('search')
  const [ai, setAi] = useState(null)               // GET /config's ai block: allowance and availability
  const [aiMode, setAiMode] = useState(null)       // null | 'photo' | 'text'
  const [carry, setCarry] = useState('')           // what the person typed before the AI failed
  const [aiText, setAiText] = useState('')         // the search words, carried into Describe
  useEffect(() => { let live = true; nutri.getConfig().then(c => live && setAi(c.ai)).catch(() => {}); return () => { live = false } }, [])

  if (aiMode) return <AiLog mode={aiMode} initialText={aiText} date={date} meal={meal} ai={ai} onAi={a => setAi(x => ({ ...x, ...a }))}
    onBack={() => { setAiMode(null); setAiText('') }} onSaved={onSaved} close={close}
    onManual={name => { setCarry(name || ''); setAiMode(null); setTab('quick') }} />

  const blocked = ai && (!ai.available || ai.remaining <= 0)
  const why = !ai ? '' : !ai.available ? unavailableText(ai.reason) : ai.remaining <= 0 ? 'You have used all of today’s AI analyses.' : allowanceText(ai)
  return <>
    <h3>{nt('Add food')}</h3>
    <SelectRow title={nt('Meal')} sheetTitle={nt('Meal')} value={meal} onChange={setMeal} options={mealOptions()} />
    <div className="nut-ai-row">
      <Button icon="camera" variant="tinted" onClick={() => setAiMode('photo')} disabled={blocked}>{nt('Photo')}</Button>
      <Button icon="sparkles" variant="tinted" onClick={() => { setAiText(''); setAiMode('text') }} disabled={blocked}>{nt('Describe')}</Button>
    </div>
    {why && <div className={'small nut-ai-why' + (blocked ? ' off' : '')}>{nt(why)}</div>}
    <Segmented value={tab} onChange={setTab} options={[{ value: 'search', label: nt('Search') }, { value: 'foods', label: nt('My foods') }, { value: 'quick', label: nt('Quick add') }]} />
    <div style={{ height: 12 }} />
    {tab === 'quick' ? <QuickAdd date={date} meal={meal} initialName={carry} onSaved={onSaved} close={close} />
      : tab === 'foods' ? <FoodPick date={date} meal={meal} onSaved={onSaved} close={close} />
      : <SearchTab date={date} meal={meal} ai={ai} onSaved={onSaved} close={close}
          onDescribe={text => { setAiText(text); setAiMode('text') }} onQuick={text => { setCarry(text); setTab('quick') }} />}
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>{nt('Cancel')}</Button>
  </>
}

export const openAddSheet = props => useUI.getState().openSheet(close => <AddSheet {...props} close={close} />)

/* ------------------------------ edit an entry ------------------------------ */

function EditEntry({ entry, date, onSaved, close }) {
  const [name, setName] = useState(entry.name)
  const [meal, setMeal] = useState(entry.meal)
  const [day, setDay] = useState(date)
  const [m, setM] = useState({ calories: entry.calories, protein_g: entry.protein_g, carbs_g: entry.carbs_g, fat_g: entry.fat_g })
  const [busy, setBusy] = useState(false)
  // The amount. `base` is what one unit is worth and never changes while this sheet is open (nor, once saved,
  // afterwards), so every amount is base × amount and edits cannot compound rounding. Numbers typed by hand
  // after the amount was changed are remembered in `manual` and are not overwritten by later amount changes.
  const base = useRef(entryBase(entry)).current
  const [qty, setQty] = useState(base.qty)
  const [manual, setManual] = useState({})
  // Micronutrients of this entry (whole-entry amounts). They follow the amount like the macros unless typed by hand.
  const [mi, setMi] = useState(entry.micros || {})
  const [miManual, setMiManual] = useState(false)
  const hasFood = entry.source === 'food'
  const grams = gramsForQty(base, qty)
  const changed = qty !== base.qty
  const applyQty = (q, keep = manual) => {
    if (!(q >= 0.01 && q <= 1000)) return
    setQty(q)
    setM(cur => ({ ...cur, ...scaleEntry(base, q, cur, keep) }))
    if (!miManual && hasMicros(base.micros)) setMi(scaleMicros(base.micros, q))
  }
  const editMacro = next => {
    const k = Object.keys(next).find(key => next[key] !== m[key])
    setM(next)
    if (k && changed) setManual(cur => ({ ...cur, [k]: true }))
  }
  const manualKeys = Object.keys(manual).filter(k => manual[k])
  const resetManual = () => { setManual({}); setM(cur => ({ ...cur, ...scaleEntry(base, qty, cur, {}) })) }

  const save = async () => {
    const r = quickBody({ name, meal, ...m }, day)
    if (!r.ok) { toast(nt(r.error)); return }
    const { date: _d, source: _s, ...patch } = r.body
    setBusy(true)
    try {
      // Micronutrients: sent only when there is something to say (typed or scaled) or something to clear.
      const typedMi = cleanMicros(mi)
      const microsOut = hasMicros(typedMi) ? { micros: typedMi } : entry.micros ? { micros: {} } : {}
      await nutri.updateEntry(date, entry.id, { ...patch, ...(changed ? amountPatch(base, qty) : {}), ...microsOut, ...(day !== date ? { newDate: day } : {}) })
      onSaved(); close(); toast(nt('Saved'))
    } catch (e) { fail(e); setBusy(false) }
  }
  const remove = () => confirmSheet({
    title: nt('Delete this entry?'), message: entry.name, confirmText: nt('Delete'), danger: true,
    onConfirm: async () => { try { await nutri.deleteEntry(date, entry.id); onSaved(); close(); toast(nt('Deleted')) } catch (e) { fail(e) } }
  })

  return <>
    <h3>{nt('Edit entry')}</h3>
    {entry.source === 'ai' && <div className="nut-note small"><Icon name="sparkles" /> {nt('Estimated by AI — check the numbers.')}</div>}
    <TextField value={name} maxLength={120} onChange={e => setName(e.target.value)} aria-label={nt('Name')} />
    {hasFood && entry.serving && <div className="muted small" style={{ margin: '6px 2px 0' }}>{nt('One serving: {0}', entry.serving)}</div>}
    <div className="row between nut-amount">
      <span>{hasFood ? nt('Servings') : nt('Amount (× as logged)')}</span>
      <Stepper value={qty} step={base.gramsPer === 100 ? 0.25 : 0.5} min={0.01} max={1000} onChange={applyQty} ariaLabel={hasFood ? nt('Servings') : nt('Amount multiplier')} />
    </div>
    {grams != null && <label className="nut-datefield nut-amount">
      <span>{nt('Weight')}</span>
      <span className="nut-input nut-cap"><NumberField value={grams} onChange={g => { const q = qtyForGramsOf(base, g); if (q) applyQty(q) }} aria-label={nt('Weight in grams')} /><i>g</i></span>
    </label>}
    {!hasFood && <div className="muted small nut-amount-note">{nt('Scales the numbers you logged in proportion. For an estimate, that is as good as the estimate was.')}</div>}
    <div style={{ height: 10 }} />
    <MacroFields v={m} set={editMacro} />
    <MoreNutrients v={mi} set={nv => { setMi(nv); if (changed) setMiManual(true) }} note={nt('Amounts for this whole entry. Leave a box empty if unknown: that stays unknown, not 0.')} />
    {manualKeys.length > 0 && <div className="nut-banner nut-manual"><span>{nt('You edited {0} by hand. It stays as you set it when you change the amount.', manualKeys.map(k => nt(MACRO_LABEL[k]).toLowerCase()).join(', '))}</span> <button className="linkbtn" onClick={resetManual}>{nt('Recalculate')}</button></div>}
    <div style={{ height: 10 }} />
    <SelectRow title={nt('Meal')} sheetTitle={nt('Meal')} value={meal} onChange={setMeal} options={mealOptions()} />
    <label className="nut-datefield"><span>{nt('Date')}</span><input className="field" type="date" value={day} onChange={e => e.target.value && setDay(e.target.value)} /></label>
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={save} disabled={busy}>{nt('Save')}</Button>
    <div style={{ height: 8 }} />
    <Button icon="plus" onClick={() => openSaveFood({ initial: foodFromEntry({ ...entry, name, micros: hasMicros(cleanMicros(mi)) ? mi : entry.micros }) })}>{nt('Save as food')}</Button>
    <div className="muted small" style={{ margin: '4px 2px 0' }}>{nt('Saves one serving of this entry, as stored, to My foods.')}</div>
    <div style={{ height: 8 }} />
    <Button variant="ghost" style={{ color: 'var(--red)' }} icon="trash" onClick={remove}>{nt('Delete')}</Button>
    <div style={{ height: 4 }} />
    <Button variant="ghost" className="dim" onClick={close}>{nt('Cancel')}</Button>
  </>
}

export const openEditEntry = props => useUI.getState().openSheet(close => <EditEntry {...props} close={close} />)

/* ------------------------------ a custom food ------------------------------ */

function FoodSheet({ food, prefill, onSaved, close }) {
  const readOnly = !!food && food.source !== 'custom'
  const [f, setF] = useState({ name: food?.name || prefill?.name || '', brand: food?.brand || '', serving: food?.serving?.label || '', grams: food?.serving?.grams ?? null })
  const [m, setM] = useState({ calories: food?.per.calories ?? null, protein_g: food?.per.protein_g ?? null, carbs_g: food?.per.carbs_g ?? null, fat_g: food?.per.fat_g ?? null })
  const [busy, setBusy] = useState(false)
  const [mi, setMi] = useState(food?.micros || {})

  const save = async () => {
    // Micronutrients are sent when typed, or (as an empty object) to clear ones the food had.
    const typed = cleanMicros(mi)
    const r = foodBody({ ...f, ...m, ext: food?.ext ?? prefill?.ext, ...(hasMicros(typed) || food?.micros ? { micros: typed } : {}) })
    if (!r.ok) { toast(nt(r.error)); return }
    setBusy(true)
    try {
      if (food) await nutri.updateFood(food.id, r.body); else await nutri.createFood(r.body)
      onSaved(); close(); toast(nt('Saved'))
    } catch (e) { fail(e); setBusy(false) }
  }
  const remove = () => confirmSheet({
    title: nt('Delete this food?'), message: nt('Entries you already logged keep their numbers.'), confirmText: nt('Delete'), danger: true,
    onConfirm: async () => { try { await nutri.deleteFood(food.id); onSaved(); close(); toast(nt('Deleted')) } catch (e) { fail(e) } }
  })

  return <>
    <h3>{food ? nt('Food') : nt('New food')}{food?.origin === 'ai' && <span className="tag nut-src nut-ai-badge">{nt('AI estimate')}</span>}</h3>
    {readOnly && <div className="muted small" style={{ marginBottom: 10 }}>{nt('This food came from a lookup, so its numbers cannot be edited.')}</div>}
    <TextField value={f.name} maxLength={120} placeholder={nt('Name')} disabled={readOnly} onChange={e => setF({ ...f, name: e.target.value })} aria-label={nt('Name')} />
    <div style={{ height: 8 }} />
    <TextField value={f.brand} maxLength={60} placeholder={nt('Brand (optional)')} disabled={readOnly} onChange={e => setF({ ...f, brand: e.target.value })} aria-label={nt('Brand')} />
    <div className="nut-section-t">{nt('One serving')}</div>
    <div className="nut-fields">
      <label className="nut-field"><span>{nt('Serving')}</span><span className="nut-input"><TextField value={f.serving} maxLength={60} placeholder={nt('1 serving')} disabled={readOnly} onChange={e => setF({ ...f, serving: e.target.value })} aria-label={nt('Serving')} /></span></label>
      <label className="nut-field"><span>{nt('Weight')}</span><span className="nut-input"><NumberField nullable value={f.grams} disabled={readOnly} onChange={n => setF({ ...f, grams: n })} aria-label={nt('Weight')} /><i>g</i></span></label>
    </div>
    <div style={{ height: 8 }} />
    <MacroFields v={m} set={setM} disabled={readOnly} />
    <MoreNutrients v={mi} set={setMi} disabled={readOnly} note={nt('Per serving. Leave a box empty if unknown: that stays unknown, not 0.')} />
    <div style={{ height: 14 }} />
    {!readOnly && <Button variant="primary" onClick={save} disabled={busy}>{nt('Save')}</Button>}
    {food && <><div style={{ height: 8 }} /><Button variant="ghost" style={{ color: 'var(--red)' }} icon="trash" onClick={remove}>{nt('Delete')}</Button></>}
    <div style={{ height: 4 }} />
    <Button variant="ghost" className="dim" onClick={close}>{readOnly ? nt('Close') : nt('Cancel')}</Button>
  </>
}

export const openFoodSheet = props => useUI.getState().openSheet(close => <FoodSheet {...props} close={close} />)
