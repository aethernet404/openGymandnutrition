// Vitamins & supplements: the sheet behind the section's Add button. Log a saved supplement in one tap (with the
// servings stepper), type a new one (name, brand, servings, nutrients per serving with a quick way to add the common ones,
// optional calories that default to 0), or log "my usual stack" — several saved supplements at once. Saved supplements are
// ordinary saved foods with type 'supplement', listed apart from foods, with favourites, recents, edit and delete.
import { useEffect, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, SearchField, Segmented, Stepper, Switch, TextField } from '../components/ui.jsx'
import { useUI } from '../store/useUI.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { foodBody } from './diary.js'
import { BY_KEY, COMMON_SUPPLEMENT_KEYS, hasMicros, microsForSend, scaleMicros } from './micros.js'
import { OtherList } from './LabelFlow.jsx'
import SupplementAdd from './SupplementAdd.jsx'
import { DuplicateChoice, MoreNutrients, openFoodSheet } from './sheets.jsx'

const toast = m => useUI.getState().toast(m)
const fail = e => toast(e?.message || nt('Something went wrong'))
const kcalOf = f => Math.round(f.per?.calories || 0)
const nutrientCount = f => Object.keys(f.micros || {}).length

/** The common nutrients as chips: tap one to get its box; everything else is under More nutrients. */
function QuickNutrients({ v, set }) {
  const [shown, setShown] = useState(() => COMMON_SUPPLEMENT_KEYS.filter(k => v[k] != null))
  return <div className="nut-qn">
    <div className="nut-section-t">{nt('Nutrients in one serving')}</div>
    {shown.length > 0 && <div className="nut-fields">
      {shown.map(k => <label className="nut-field" key={k}>
        <span>{nt(BY_KEY[k].label)}</span>
        <span className="nut-input"><NumberField nullable value={v[k] ?? null} onChange={x => set({ ...v, [k]: x })} aria-label={nt(BY_KEY[k].label)} /><i>{BY_KEY[k].unit}</i></span>
      </label>)}
    </div>}
    <div className="nut-chips" role="group" aria-label={nt('Add a common nutrient')}>
      {COMMON_SUPPLEMENT_KEYS.filter(k => !shown.includes(k)).map(k => <button type="button" key={k} className="nut-chip" onClick={() => setShown(s => [...s, k])}>+ {nt(BY_KEY[k].label)}</button>)}
    </div>
  </div>
}

/** Log a saved supplement: servings stepper, what it adds, one button. No AI, no photo. */
function Portion({ food, date, onBack, onDone, onEdit }) {
  const [qty, setQty] = useState(1)
  const [busy, setBusy] = useState(false)
  const add = async () => {
    setBusy(true)
    try { await nutri.addEntries({ date, meal: 'supplements', source: 'food', foodId: food.id, qty }); onDone(); toast(nt('Added')) } catch (e) { fail(e); setBusy(false) }
  }
  return <>
    <button className="nut-back" onClick={onBack}><Icon name="chevronLeft" />{nt('Back')}</button>
    <div className="nut-picked"><b>{food.name}</b>{food.brand && <span className="muted"> · {food.brand}</span>}</div>
    <div className="muted small">{nt('One serving: {0}', food.serving?.label || nt('1 serving'))}</div>
    <div className="row between" style={{ margin: '12px 0 8px' }}>
      <span>{nt('Servings')}</span>
      <Stepper value={qty} step={1} min={0.5} max={100} onChange={setQty} ariaLabel={nt('Servings')} />
    </div>
    <div className="nut-preview">{nutrientCount(food) ? nt('{0} nutrients', nutrientCount(food)) : nt('No nutrient amounts saved')}{kcalOf(food) > 0 ? <span className="muted"> · {Math.round(kcalOf(food) * qty)} kcal</span> : null}</div>
    <OtherList list={food.otherIngredients} />
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={add} disabled={busy}>{nt('Add to supplements')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={onEdit}>{nt('Edit this supplement')}</Button>
  </>
}

/** A new supplement: saved to My supplements (default on) and logged, or just logged. */
function NewSupplement({ date, onDone }) {
  const [f, setF] = useState({ name: '', brand: '', serving: '', calories: null })
  const [qty, setQty] = useState(1)
  const [mi, setMi] = useState({})
  const [saveIt, setSaveIt] = useState(true)
  const [dup, setDup] = useState(null)
  const [busy, setBusy] = useState(false)

  const go = async choice => {
    const typed = microsForSend(mi)
    if (!typed.ok) { toast(nt(typed.error)); return }
    const cal = f.calories ?? 0
    const fb = foodBody({ name: f.name, brand: f.brand, serving: f.serving, grams: null, calories: cal, protein_g: 0, carbs_g: 0, fat_g: 0, micros: typed.micros })
    if (!fb.ok) { toast(nt(fb.error)); return }
    setBusy(true)
    try {
      if (saveIt) {
        const { ext: _e, ...body } = fb.body
        const out = await nutri.createFood({ ...body, type: 'supplement', checkDuplicate: true, ...(choice ? { onDuplicate: choice } : {}) })
        await nutri.addEntries({ date, meal: 'supplements', source: 'food', foodId: out.food.id, qty })
      } else {
        const b = fb.body
        await nutri.addEntries({
          date, meal: 'supplements', source: 'supplement', name: b.name, brand: b.brand, serving: b.serving, qty,
          calories: Math.round(cal * qty), protein_g: 0, carbs_g: 0, fat_g: 0,
          ...(hasMicros(typed.micros) ? { micros: scaleMicros(typed.micros, qty), base: { calories: cal, protein_g: 0, carbs_g: 0, fat_g: 0, grams: null, micros: typed.micros } } : {})
        })
      }
      onDone(); toast(saveIt ? nt('Saved to My supplements and added') : nt('Added'))
    } catch (e) {
      if (e.status === 409 && e.data?.code === 'duplicate') { setDup(e.data.existing); setBusy(false); return }
      fail(e); setBusy(false)
    }
  }

  return <>
    <TextField value={f.name} maxLength={120} placeholder={nt('Name, e.g. Vitamin D3 2000 IU')} onChange={e => { setF({ ...f, name: e.target.value }); setDup(null) }} aria-label={nt('Supplement name')} />
    <div style={{ height: 8 }} />
    <TextField value={f.brand} maxLength={60} placeholder={nt('Brand (optional)')} onChange={e => { setF({ ...f, brand: e.target.value }); setDup(null) }} aria-label={nt('Supplement brand')} />
    <div className="nut-fields" style={{ marginTop: 10 }}>
      <label className="nut-field"><span>{nt('One serving is')}</span><span className="nut-input"><TextField value={f.serving} maxLength={60} placeholder={nt('e.g. 1 capsule')} onChange={e => setF({ ...f, serving: e.target.value })} aria-label={nt('Serving')} /></span></label>
      <label className="nut-field"><span>{nt('Calories (optional)')}</span><span className="nut-input"><NumberField nullable value={f.calories} onChange={n => setF({ ...f, calories: n })} aria-label={nt('Calories per serving')} /><i>kcal</i></span></label>
    </div>
    <div className="row between" style={{ margin: '12px 0 4px' }}>
      <span>{nt('Servings taken')}</span>
      <Stepper value={qty} step={1} min={0.5} max={100} onChange={setQty} ariaLabel={nt('Servings taken')} />
    </div>
    <QuickNutrients v={mi} set={setMi} />
    <MoreNutrients v={mi} set={setMi} note={nt('Per serving, as on the label. Leave a box empty if the label does not say.')} />
    <div className="row between nut-savebox" style={{ marginTop: 12 }}>
      <span>{nt('Save to My supplements')}</span>
      <Switch checked={saveIt} onChange={setSaveIt} aria-label={nt('Save to My supplements')} />
    </div>
    <div className="muted small" style={{ margin: '4px 2px 0' }}>{saveIt ? nt('Next time, one tap logs it again.') : nt('Only logged today; nothing is saved for later.')}</div>
    {dup && <><div style={{ height: 10 }} /><DuplicateChoice existing={dup} onChoose={go} busy={busy} /></>}
    <div style={{ height: 14 }} />
    {!dup && <Button variant="primary" onClick={() => go(null)} disabled={busy}>{nt('Add to supplements')}</Button>}
  </>
}

/** My usual stack: pick saved supplements and servings; log them all at once. */
function Stack({ date, onBack, onDone }) {
  const [foods, setFoods] = useState(null)
  const [pick, setPick] = useState({})               // foodId → servings
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    Promise.all([nutri.listFoods('all', '', 'supplement'), nutri.getStack()]).then(([f, s]) => {
      if (!live) return
      setFoods(f.foods); setPick(Object.fromEntries((s.items || []).map(i => [i.foodId, i.qty])))
    }).catch(e => { if (live) { setFoods([]); fail(e) } })
    return () => { live = false }
  }, [])
  const items = Object.entries(pick).map(([foodId, qty]) => ({ foodId, qty }))
  const toggle = f => setPick(p => { const n = { ...p }; if (n[f.id] != null) delete n[f.id]; else n[f.id] = 1; return n })
  const save = async andLog => {
    setBusy(true)
    try {
      await nutri.putStack(items)
      if (andLog && items.length) await nutri.addEntries({ date, meal: 'supplements', entries: items.map(i => ({ source: 'food', foodId: i.foodId, qty: i.qty })) })
      if (andLog) { onDone(); toast(nt('Logged {0} supplements', items.length)) } else { toast(nt('Stack saved')); onBack() }
    } catch (e) { fail(e); setBusy(false) }
  }
  return <>
    <button className="nut-back" onClick={onBack}><Icon name="chevronLeft" />{nt('Back')}</button>
    <h3>{nt('My usual stack')}</h3>
    <div className="muted small" style={{ margin: '0 0 10px' }}>{nt('Choose the supplements you usually take and how many servings. Then one tap logs them all.')}</div>
    {foods === null && <div className="muted small nut-empty">{nt('Loading…')}</div>}
    {foods?.length === 0 && <div className="muted small nut-empty">{nt('No saved supplements yet. Add one under New, with Save turned on.')}</div>}
    <div className="nut-pick-list">
      {foods?.map(f => <div key={f.id} className="nut-stack-row">
        <button className={'nut-stack-pick' + (pick[f.id] != null ? ' on' : '')} onClick={() => toggle(f)} aria-pressed={pick[f.id] != null}>
          <span className="nut-stack-box" aria-hidden="true">{pick[f.id] != null && <Icon name="check" />}</span>
          <span className="nut-pick-m"><span className="nut-pick-t">{f.name}</span><span className="nut-pick-s">{f.brand ? f.brand + ' · ' : ''}{f.serving?.label}</span></span>
        </button>
        {pick[f.id] != null && <Stepper value={pick[f.id]} step={1} min={0.5} max={100} onChange={q => setPick(p => ({ ...p, [f.id]: q }))} ariaLabel={nt('Servings of {0}', f.name)} />}
      </div>)}
    </div>
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={() => save(true)} disabled={busy || !items.length}>{nt('Save stack and log it now')}</Button>
    <div style={{ height: 8 }} />
    <Button onClick={() => save(false)} disabled={busy}>{nt('Save stack')}</Button>
  </>
}

function SupplementSheet({ date, onSaved, close }) {
  const [view, setView] = useState('list')            // list | portion | stack
  const [tab, setTab] = useState('mine')              // mine | new
  const [scope, setScope] = useState('recent')
  const [text, setText] = useState('')
  const [foods, setFoods] = useState(null)
  const [picked, setPicked] = useState(null)
  const [stack, setStack] = useState([])
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  const load = () => {
    const n = ++seq.current
    nutri.listFoods(scope, text, 'supplement').then(r => { if (n === seq.current) setFoods(r.foods) }).catch(e => { if (n === seq.current) { setFoods([]); fail(e) } })
  }
  useEffect(() => { const id = setTimeout(load, text ? 200 : 0); return () => clearTimeout(id) }, [scope, text])
  const loadStack = () => Promise.resolve(nutri.getStack()).then(r => setStack(r?.items || [])).catch(() => {})
  useEffect(() => { loadStack() }, [])
  const done = () => { onSaved(); close() }

  const logStack = async () => {
    setBusy(true)
    try {
      await nutri.addEntries({ date, meal: 'supplements', entries: stack.map(i => ({ source: 'food', foodId: i.foodId, qty: i.qty })) })
      onSaved(); close(); toast(nt('Logged {0} supplements', stack.length))
    } catch (e) { fail(e); setBusy(false) }
  }

  if (view === 'stack') return <Stack date={date} onBack={() => { setView('list'); loadStack() }} onDone={done} />
  if (view === 'portion' && picked) return <Portion food={picked} date={date} onBack={() => setView('list')} onDone={done} onEdit={() => openFoodSheet({ food: picked, onSaved: () => { onSaved(); close() } })} />

  return <>
    <h3>{nt('Vitamins & supplements')}</h3>
    <div className="nut-stackbar">
      <Button variant="primary" icon="plus" onClick={logStack} disabled={busy || stack.length === 0}>{stack.length ? nt('Log my usual stack ({0})', stack.length) : nt('Log my usual stack')}</Button>
      <Button size="sm" onClick={() => setView('stack')}>{stack.length ? nt('Edit stack') : nt('Set up my stack')}</Button>
    </div>
    <div style={{ height: 10 }} />
    <Segmented value={tab} onChange={setTab} options={[{ value: 'mine', label: nt('My supplements') }, { value: 'new', label: nt('New') }]} />
    <div style={{ height: 10 }} />
    {tab === 'new' ? <SupplementAdd date={date} onDone={done} close={close} manual={<NewSupplement date={date} onDone={done} />} /> : <>
      <Segmented value={scope} onChange={setScope} options={[{ value: 'recent', label: nt('Recent') }, { value: 'favorite', label: nt('Favourites') }, { value: 'all', label: nt('All') }]} />
      <div style={{ height: 10 }} />
      <SearchField value={text} onChange={e => setText(e.target.value)} onClear={() => setText('')} placeholder={nt('Search my supplements')} />
      <div className="nut-pick-list">
        {foods === null && <div className="muted small nut-empty">{nt('Loading…')}</div>}
        {foods?.length === 0 && <div className="muted small nut-empty">
          {scope === 'recent' ? nt('Supplements you log appear here.') : nt('No supplements yet.')}
          <div style={{ marginTop: 10 }}><Button size="sm" icon="plus" onClick={() => setTab('new')}>{nt('Add a supplement')}</Button></div>
        </div>}
        {foods?.map(f => <button key={f.id} className="nut-pick" onClick={() => { setPicked(f); setView('portion') }}>
          <span className="nut-pick-m"><span className="nut-pick-t">{f.name}</span><span className="nut-pick-s">{f.brand ? f.brand + ' · ' : ''}{f.serving?.label}{nutrientCount(f) ? ' · ' + nt('{0} nutrients', nutrientCount(f)) : ''}</span></span>
          {kcalOf(f) > 0 && <span className="nut-kcal">{kcalOf(f)}</span>}
        </button>)}
      </div>
    </>}
    <div style={{ height: 10 }} />
    <Button variant="ghost" className="dim" onClick={close}>{nt('Close')}</Button>
  </>
}

export const openSupplementSheet = props => useUI.getState().openSheet(close => <SupplementSheet {...props} close={close} />)
