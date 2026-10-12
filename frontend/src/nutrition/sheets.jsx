// The bottom sheets of the diary: add (quick or from a food), edit an entry, edit a food.
// Opened through useUI().openSheet like every other sheet in the app; each takes `close` and
// calls `onSaved` after the server has accepted the change, so the screen behind reloads.
import { useEffect, useRef, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { Button, NumberField, SearchField, Segmented, SelectRow, Stepper, TextField } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import { confirmSheet } from '../sheets.jsx'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { MEALS, MEAL_LABEL, foodBody, macroLine, quickBody, scaleFood, trim } from './diary.js'

const toast = m => useUI.getState().toast(m)
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

/* ------------------------------ add to a meal ------------------------------ */

function QuickAdd({ date, meal, setMeal, onSaved, close }) {
  const [name, setName] = useState('')
  const [m, setM] = useState({ calories: null, protein_g: null, carbs_g: null, fat_g: null })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const r = quickBody({ name, meal, ...m }, date)
    if (!r.ok) { toast(nt(r.error)); return }
    setBusy(true)
    try { await nutri.addEntries(r.body); onSaved(); close(); toast(nt('Added')) } catch (e) { fail(e); setBusy(false) }
  }
  return <>
    <TextField value={name} maxLength={120} placeholder={nt('Name (optional)')} onChange={e => setName(e.target.value)} aria-label={nt('Name')} />
    <div style={{ height: 10 }} />
    <MacroFields v={m} set={setM} />
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={save} disabled={busy}>{nt('Add to {0}', nt(MEAL_LABEL[meal]).toLowerCase())}</Button>
  </>
}

function FoodPick({ date, meal, onSaved, close }) {
  const [scope, setScope] = useState('recent')
  const [text, setText] = useState('')
  const [foods, setFoods] = useState(null)
  const [picked, setPicked] = useState(null)
  const [qty, setQty] = useState(1)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  const load = () => {
    const n = ++seq.current
    nutri.listFoods(scope, text).then(r => { if (n === seq.current) setFoods(r.foods) }).catch(e => { if (n === seq.current) { setFoods([]); fail(e) } })
  }
  useEffect(() => { const id = setTimeout(load, text ? 200 : 0); return () => clearTimeout(id) }, [scope, text])

  const add = async () => {
    setBusy(true)
    try {
      await nutri.addEntries({ date, meal, source: 'food', foodId: picked.id, qty })
      onSaved(); close(); toast(nt('Added'))
    } catch (e) { fail(e); setBusy(false) }
  }

  if (picked) {
    const s = scaleFood(picked, qty)
    return <>
      <button className="nut-back" onClick={() => setPicked(null)}><Icon name="chevronLeft" />{nt('Back')}</button>
      <div className="nut-picked"><b>{picked.name}</b>{picked.brand && <span className="muted"> · {picked.brand}</span>}</div>
      <div className="muted small">{nt('One serving: {0}', picked.serving.label)}</div>
      <div className="row between" style={{ margin: '12px 0' }}>
        <span>{nt('Servings')}</span>
        <Stepper value={qty} step={0.5} min={0.25} max={100} onChange={setQty} ariaLabel={nt('Servings')} />
      </div>
      <div className="nut-preview"><b>{s.calories}</b> kcal<span className="muted"> · {macroLine(s)}{s.grams ? ` · ${trim(s.grams)} g` : ''}</span></div>
      <div style={{ height: 14 }} />
      <Button variant="primary" onClick={add} disabled={busy}>{nt('Add to {0}', nt(MEAL_LABEL[meal]).toLowerCase())}</Button>
    </>
  }

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
      {foods?.map(f => <button key={f.id} className="nut-pick" onClick={() => { setPicked(f); setQty(1) }}>
        <span className="nut-pick-m"><span className="nut-pick-t">{f.name}</span><span className="nut-pick-s">{f.brand ? f.brand + ' · ' : ''}{f.serving.label} · {macroLine(f.per)}</span></span>
        <span className="nut-kcal">{f.per.calories}</span>
      </button>)}
    </div>
  </>
}

function AddSheet({ date, meal: initial, onSaved, close }) {
  const [meal, setMeal] = useState(initial)
  const [tab, setTab] = useState('quick')
  return <>
    <h3>{nt('Add food')}</h3>
    <SelectRow title={nt('Meal')} sheetTitle={nt('Meal')} value={meal} onChange={setMeal} options={mealOptions()} />
    <div style={{ height: 10 }} />
    <Segmented value={tab} onChange={setTab} options={[{ value: 'quick', label: nt('Quick add') }, { value: 'foods', label: nt('My foods') }]} />
    <div style={{ height: 12 }} />
    {tab === 'quick' ? <QuickAdd date={date} meal={meal} onSaved={onSaved} close={close} /> : <FoodPick date={date} meal={meal} onSaved={onSaved} close={close} />}
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

  const save = async () => {
    const r = quickBody({ name, meal, ...m }, day)
    if (!r.ok) { toast(nt(r.error)); return }
    const { date: _d, source: _s, ...patch } = r.body
    setBusy(true)
    try {
      await nutri.updateEntry(date, entry.id, { ...patch, ...(day !== date ? { newDate: day } : {}) })
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
    {(entry.serving || entry.qty > 0) && entry.source === 'food' && <div className="muted small" style={{ margin: '6px 2px 0' }}>{trim(entry.qty)} × {entry.serving}</div>}
    <div style={{ height: 10 }} />
    <MacroFields v={m} set={setM} />
    <div style={{ height: 10 }} />
    <SelectRow title={nt('Meal')} sheetTitle={nt('Meal')} value={meal} onChange={setMeal} options={mealOptions()} />
    <label className="nut-datefield"><span>{nt('Date')}</span><input className="field" type="date" value={day} onChange={e => e.target.value && setDay(e.target.value)} /></label>
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={save} disabled={busy}>{nt('Save')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" style={{ color: 'var(--red)' }} icon="trash" onClick={remove}>{nt('Delete')}</Button>
    <div style={{ height: 4 }} />
    <Button variant="ghost" className="dim" onClick={close}>{nt('Cancel')}</Button>
  </>
}

export const openEditEntry = props => useUI.getState().openSheet(close => <EditEntry {...props} close={close} />)

/* ------------------------------ a custom food ------------------------------ */

function FoodSheet({ food, onSaved, close }) {
  const readOnly = !!food && food.source !== 'custom'
  const [f, setF] = useState({ name: food?.name || '', brand: food?.brand || '', serving: food?.serving?.label || '', grams: food?.serving?.grams ?? null })
  const [m, setM] = useState({ calories: food?.per.calories ?? null, protein_g: food?.per.protein_g ?? null, carbs_g: food?.per.carbs_g ?? null, fat_g: food?.per.fat_g ?? null })
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const r = foodBody({ ...f, ...m, ext: food?.ext })
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
    <h3>{food ? nt('Food') : nt('New food')}</h3>
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
    <div style={{ height: 14 }} />
    {!readOnly && <Button variant="primary" onClick={save} disabled={busy}>{nt('Save')}</Button>}
    {food && <><div style={{ height: 8 }} /><Button variant="ghost" style={{ color: 'var(--red)' }} icon="trash" onClick={remove}>{nt('Delete')}</Button></>}
    <div style={{ height: 4 }} />
    <Button variant="ghost" className="dim" onClick={close}>{readOnly ? nt('Close') : nt('Cancel')}</Button>
  </>
}

export const openFoodSheet = props => useUI.getState().openSheet(close => <FoodSheet {...props} close={close} />)
