// "Scan a label": 1 to 4 photos (camera or several from the library) → the AI reads the label → an editable review → log it, save it, or both.
//
// What the person is promised, enforced in code:
//   · the photos are shrunk on this device, sent once, and never stored (they live in this component's state only);
//   · nothing is saved until a button is pressed on the review; what the AI read is only ever form values to check;
//   · a row it could not read is highlighted; two columns (as packaged / as prepared) are a choice;
//   · the same barcode, or the same name and brand, is offered back as "use the saved one" before a second copy is made.
// Four ways to arrive (`mode`): 'food' and 'supplement' (Add), 'fill' (a form wants the values), 'entry' (label values for an
// entry that has no vitamins and minerals). A hit from a database (DSLD, a saved supplement) arrives as `initial` and is
// reviewed the same way.
import { useEffect, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, Segmented, Stepper, TextField } from '../components/ui.jsx'
import { useUI } from '../store/useUI.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { allowanceText, unavailableText } from './ai.js'
import { LABEL_NOTE, conflicts, defaultColumn, entryMicros, formOf, logBody, rowsToCheck, savedBody } from './labelForm.js'
import { MAX_PHOTOS, addPhotos, removePhoto } from './labelPhotos.js'
import { BY_KEY, amountText, cleanMicros } from './micros.js'
import { MEAL_LABEL, trim } from './diary.js'
import { DuplicateChoice, MacroFields, MoreNutrients } from './sheets.jsx'
import { NihCredit } from './SupplementAdd.jsx'
import { dateLocale } from '../lib/i18n.js'

const toast = m => useUI.getState().toast(m)
const fail = e => toast(e?.message || nt('Something went wrong'))
/** Other ingredients of a saved product: shown, never counted in any total or limit. */
export const OtherList = ({ list }) => (list?.length ? <div className="nut-lab-other"><b className="small">{nt('Other ingredients')}</b>
  <div className="muted small">{nt('Shown only: never counted in any total or limit.')}</div>
  <ul>{list.map((o, i) => <li key={i}><span>{o.name}{o.amount != null ? ` · ${o.amount} ${o.unit || ''}` : ''}</span></li>)}</ul></div> : null)
export const NIH_NOTE = 'From the NIH Dietary Supplement Label Database (DSLD). Please check it against your bottle.'

/** The AI allowance and whether the AI can run at all, from the server's config. */
function useAi() {
  const [ai, setAi] = useState(null)
  useEffect(() => {
    let live = true
    Promise.resolve(nutri.getConfig()).then(c => { if (live && c) setAi(c.ai || null) }).catch(() => {})
    return () => { live = false }
  }, [])
  return [ai, setAi]
}

/* ------------------------------ the photos ------------------------------ */

function Capture({ hint, upc, onRead, onBack, title, ai, onAi }) {
  const [photos, setPhotos] = useState([])
  const [problems, setProblems] = useState([])
  const [tooBig, setTooBig] = useState(false)
  const [stage, setStage] = useState('pick')          // pick | prep | busy | error | notlabel
  const [error, setError] = useState(null)
  const [code, setCode] = useState(upc || '')
  const [reading, setReading] = useState(false)
  const alive = useRef(true)
  const camera = useRef(null)
  const library = useRef(null)
  const bc = useRef(null)
  const latest = useRef([])
  latest.current = photos
  useEffect(() => () => { alive.current = false; for (const p of latest.current) URL.revokeObjectURL(p.previewUrl) }, [])

  const add = async files => {
    if (!files?.length) return
    setStage('prep'); setError(null)
    const r = await addPhotos(photos, files)
    if (!alive.current) return
    setPhotos(r.photos); setTooBig(r.tooBig); setProblems(r.problems); setStage('pick')
  }
  const remove = i => {
    const next = removePhoto(photos, i)
    setPhotos(next); setProblems([]); setTooBig(false)
  }
  const readBarcode = async file => {
    if (!file) return
    setReading(true)
    try {
      const { decodeFile } = await import('./barcode-decode.js')
      const r = await decodeFile(file)
      if (!alive.current) return
      if (r.ok) setCode(r.code); else setProblems(p => [...p, r.reason === 'none' ? nt('No barcode found in that photo.') : r.message])
    } finally { if (alive.current) setReading(false) }
  }

  const available = !ai || (ai.available && ai.remaining > 0)
  const run = async () => {
    setStage('busy'); setError(null)
    try {
      const r = await nutri.readLabel(photos.map(p => p.base64), hint)
      if (!alive.current) return
      if (r.ai) onAi(r.ai)
      if (!r.label?.isLabel) { setStage('notlabel'); return }
      onRead(r.label, code)
    } catch (e) {
      if (!alive.current) return
      if (e.data?.ai) onAi(e.data.ai)
      setError(e.code === 'timeout' ? nt('No answer yet. The reading may still finish on the server and count against today’s limit.') : e.status === 0 || !e.status ? nt('Could not reach the server: {0}', e.message) : e.message)
      setStage('error')
    }
  }

  return <>
    <button className="nut-back" onClick={onBack}><Icon name="chevronLeft" />{nt('Back')}</button>
    <h3>{title}</h3>
    {stage === 'busy' ? <div className="nut-busy"><div className="nut-spinner" aria-hidden="true" /><div>{nt('Reading the label…')}</div><div className="muted small">{nt('Usually 10 to 25 seconds.')}</div></div> : <>
      <div className="muted small" style={{ margin: '0 2px 10px' }}>{nt('Take a photo of the label, or choose several from your library (up to {0}): the front, the facts panel, the ingredients.', MAX_PHOTOS)}</div>
      <div className="nut-lab-strip" aria-label={nt('Your photos')}>
        {photos.map((p, i) => <div key={p.id} className="nut-lab-thumb">
          <img src={p.previewUrl} alt={nt('Photo {0}', i + 1)} />
          <button type="button" className="nut-lab-x" onClick={() => remove(i)} aria-label={nt('Remove photo {0}', i + 1)}><Icon name="xmark" /></button>
        </div>)}
        {photos.length === 0 && <div className="nut-lab-empty muted small">{stage === 'prep' ? nt('Preparing the photos…') : <Icon name="camera" />}</div>}
      </div>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={e => { add([...e.target.files]); e.target.value = '' }} />
      <input ref={library} type="file" accept="image/*" multiple hidden onChange={e => { add([...e.target.files]); e.target.value = '' }} />
      <div className="nut-ai-row" style={{ marginTop: 10 }}>
        <Button icon="camera" onClick={() => camera.current?.click()} disabled={stage === 'prep' || photos.length >= MAX_PHOTOS}>{nt('Take photo')}</Button>
        <Button icon="image" onClick={() => library.current?.click()} disabled={stage === 'prep' || photos.length >= MAX_PHOTOS}>{nt('From library')}</Button>
      </div>
      {photos.length > 0 && <div className="muted small nut-lab-count">{nt('{0} of {1} photos', photos.length, MAX_PHOTOS)}</div>}
      {problems.map((t, i) => <div key={i} className="nut-banner warn" role="alert"><Icon name="warning" /><span>{t}</span></div>)}
      <div className="nut-lab-bc">
        <input ref={bc} type="file" accept="image/*" capture="environment" hidden onChange={e => { readBarcode(e.target.files?.[0]); e.target.value = '' }} />
        {code ? <span className="small">{nt('Barcode: {0}', code)} <button type="button" className="linkbtn" onClick={() => setCode('')}>{nt('Remove')}</button></span>
          : <Button size="sm" icon="qr" onClick={() => bc.current?.click()} disabled={reading}>{reading ? nt('Reading the barcode…') : nt('Also read the barcode (optional)')}</Button>}
      </div>
      {stage === 'notlabel' && <div className="nut-banner info"><Icon name="info" /><span>{nt('That does not look like a nutrition or supplement facts label. Try a sharper, closer photo of the panel.')}</span></div>}
      {stage === 'error' && <div className="nut-banner warn" role="alert"><Icon name="warning" /><span>{error}</span></div>}
      <div className="muted small" style={{ margin: '10px 2px' }}>{nt('The photos are shrunk on your device, sent to Claude through this server’s account, and not stored.')} {ai ? nt(allowanceText(ai)) : ''}</div>
      {ai && !available && <div className="nut-banner warn"><Icon name="warning" /><span>{ai.available ? nt('You have used all of today’s AI analyses.') : nt(unavailableText(ai.reason))}</span></div>}
      <Button variant="primary" icon="sparkles" onClick={run} disabled={!photos.length || tooBig || stage === 'prep' || !available}>{nt('Read the label')}</Button>
    </>}
  </>
}

/* ------------------------------ the review ------------------------------ */

function Review({ initial, label, source, mode, date, meal, entry, onBack, onSaved, onUse, onApplied, close }) {
  const [col, setCol] = useState(label ? defaultColumn(label) : 0)
  const [f, setF] = useState(initial)
  const [qty, setQty] = useState(mode === 'entry' ? (entry?.qty ?? 1) : 1)
  const [replace, setReplace] = useState({})
  const [dup, setDup] = useState(null)
  const [busy, setBusy] = useState(false)
  const supplement = mode === 'supplement'
  const locale = dateLocale()
  const pickColumn = i => { setCol(i); setF(formOf(label, i)); setDup(null) }
  const edit = patch => { setF(cur => ({ ...cur, ...patch })); setDup(null) }
  const dropOther = i => edit({ others: f.others.filter((_, j) => j !== i) })

  const logMeal = supplement ? 'supplements' : meal
  const finish = msg => { onSaved?.(); close(); toast(msg) }

  // Save and/or log. A duplicate (same barcode, or same name and brand) is asked about before a second copy is made.
  const run = async ({ save, log, choice = null, useExisting = null }) => {
    setBusy(true)
    try {
      let food = useExisting
      if (save && !food) {
        const sb = savedBody(f, { supplement, choice })
        if (!sb.ok) { toast(nt(sb.error)); setBusy(false); return }
        try { food = (await nutri.createFood(sb.body)).food }
        catch (e) { if (e.status === 409 && e.data?.code === 'duplicate') { setDup({ existing: e.data.existing, intent: { save, log } }); setBusy(false); return } throw e }
      }
      if (log) {
        if (food) await nutri.addEntries({ date, meal: logMeal, source: 'food', foodId: food.id, qty })
        else {
          const lb = logBody(f, { date, meal: logMeal, qty, supplement })
          if (!lb.ok) { toast(nt(lb.error)); setBusy(false); return }
          await nutri.addEntries(lb.body)
        }
      }
      finish(save && log ? nt('Saved and added') : log ? nt('Added') : useExisting ? nt('Already saved: nothing new was added') : nt('Saved'))
    } catch (e) { fail(e); setBusy(false) }
  }
  const resolveDup = choice => run({ ...dup.intent, choice })
  const useSaved = () => run({ save: false, log: dup.intent.log, useExisting: dup.existing })

  const applyToEntry = async () => {
    const micros = entryMicros(f, qty)
    if (!Object.keys(micros).length) { toast(nt('There are no nutrients to add.')); return }
    setBusy(true)
    try {
      const out = await nutri.applyLabelMicros(date, entry.id, { micros, overwrite: Object.keys(replace).filter(k => replace[k]) })
      onApplied?.(out); close(); toast(nt('Label values added to this entry'))
    } catch (e) { fail(e); setBusy(false) }
  }

  const clash = mode === 'entry' ? conflicts(entry?.micros, entryMicros(f, qty)) : []
  const checks = rowsToCheck(f)
  const note = source === 'dsld' ? nt(NIH_NOTE) : source === 'mine' ? nt('Your saved supplement.') : source === 'off' || source === 'usda' ? nt('From {0}. Please check it against your bottle.', source === 'off' ? 'Open Food Facts' : 'USDA Branded Foods') : nt(LABEL_NOTE)

  return <>
    <button className="nut-back" onClick={onBack}><Icon name="chevronLeft" />{nt('Back')}</button>
    <h3>{nt('Check the label')}</h3>
    <div className="nut-banner info"><Icon name="info" /><span>{note} {nt('Fix anything that looks wrong; nothing is saved until you press a button below.')}</span></div>
    {label?.columns?.length > 1 && <div style={{ margin: '10px 0' }}>
      <div className="small muted" style={{ marginBottom: 4 }}>{nt('This label has more than one column. Which one did you eat?')}</div>
      <Segmented value={col} onChange={pickColumn} options={label.columns.map((c, i) => ({ value: i, label: c.heading || nt('Column {0}', i + 1) }))} />
    </div>}
    {source === 'dsld' && <NihCredit />}
    {f.note && <div className="muted small nut-lab-note">{nt(f.note)}</div>}
    {f.flags.map((fl, i) => <div key={i} className="nut-banner warn" role="alert"><Icon name="warning" /><span>{fl.text}</span></div>)}
    {checks.length > 0 && <div className="nut-lab-check"><b className="small">{nt('Check these rows')}</b>
      <ul>{checks.map((r, i) => <li key={i}>{r.name}{r.amount != null ? ` · ${r.amount} ${r.unit}` : ''}</li>)}</ul>
      <div className="muted small">{nt('Type the right amount into the highlighted box below.')}</div></div>}

    {mode !== 'entry' && <>
      <TextField value={f.name} maxLength={120} placeholder={nt('Name')} onChange={e => edit({ name: e.target.value })} aria-label={nt('Name')} />
      <div style={{ height: 8 }} />
      <TextField value={f.brand} maxLength={60} placeholder={nt('Brand (optional)')} onChange={e => edit({ brand: e.target.value })} aria-label={nt('Brand')} />
      <div className="nut-fields" style={{ marginTop: 10 }}>
        <label className="nut-field"><span>{nt('One serving is')}</span><span className="nut-input"><TextField value={f.serving} maxLength={60} placeholder={nt('e.g. 2 capsules')} onChange={e => edit({ serving: e.target.value })} aria-label={nt('Serving')} /></span></label>
        <label className="nut-field"><span>{nt('Weight')}</span><span className="nut-input"><NumberField nullable value={f.grams} onChange={n => edit({ grams: n })} aria-label={nt('Serving weight')} /><i>g</i></span></label>
        <label className="nut-field"><span>{nt('Servings per container')}</span><span className="nut-input"><NumberField nullable value={f.servingsPerContainer} onChange={n => edit({ servingsPerContainer: n })} aria-label={nt('Servings per container')} /></span></label>
        <label className="nut-field"><span>{nt('Barcode')}</span><span className="nut-input"><TextField value={f.upc} maxLength={14} inputMode="numeric" onChange={e => edit({ upc: e.target.value.replace(/\D/g, '') })} aria-label={nt('Barcode')} /></span></label>
      </div>
      <div style={{ height: 8 }} />
      <MacroFields v={{ calories: f.calories, protein_g: f.protein_g, carbs_g: f.carbs_g, fat_g: f.fat_g }} set={m => edit(m)} />
    </>}
    {mode === 'entry'
      ? <div className="nut-lab-entry">
        <div className="row between"><span>{nt('Servings of this label you ate')}</span><Stepper value={qty} step={0.25} min={0.01} max={1000} onChange={setQty} ariaLabel={nt('Servings')} /></div>
        <div className="muted small">{nt('The amounts below are for the whole entry.')}</div>
        <ul className="nut-fill-amounts">{Object.entries(entryMicros(f, qty)).map(([k, val]) => <li key={k}><span>{nt(BY_KEY[k].label)}</span><b>{amountText(k, val, locale)}</b></li>)}</ul>
        {clash.length > 0 && <div className="nut-banner warn"><Icon name="warning" /><span>{nt('This entry already has different amounts for these. They are kept unless you tick Replace.')}
          {clash.map(k => <label key={k} className="nut-lab-replace"><input type="checkbox" checked={!!replace[k]} onChange={e => setReplace(r => ({ ...r, [k]: e.target.checked }))} /> {nt('Replace {0}: {1} → {2}', nt(BY_KEY[k].label), amountText(k, entry.micros[k], locale), amountText(k, entryMicros(f, qty)[k], locale))}</label>)}</span></div>}
      </div>
      : <MoreNutrients v={f.micros} set={m => edit({ micros: cleanMicros(m) })} defaultOpen flagged={f.flagged} note={nt('Per serving, as read. Leave a box empty if the label does not say: that stays unknown, not 0.')} />}

    {mode !== 'entry' && f.others.length > 0 && <div className="nut-lab-other"><b className="small">{nt('Other ingredients')}</b>
      <div className="muted small">{nt('Saved with the product and shown, but never counted in any total or limit.')}</div>
      <ul>{f.others.map((o, i) => <li key={i}><span>{o.name}{o.amount != null ? ` · ${o.amount} ${o.unit || ''}` : ''}</span><button type="button" className="iconbtn" onClick={() => dropOther(i)} aria-label={nt('Remove {0}', o.name)}><Icon name="xmark" /></button></li>)}</ul></div>}
    {mode !== 'entry' && f.otherIngredientsText && <div className="muted small nut-lab-oit">{nt('Other ingredients as printed: {0}', f.otherIngredientsText)}</div>}

    {dup && <><div style={{ height: 10 }} /><DuplicateChoice existing={dup.existing} onChoose={resolveDup} onUse={useSaved} busy={busy} updateText={nt('Update the saved one with this label')} /></>}
    <div style={{ height: 14 }} />
    {!dup && (mode === 'food' || mode === 'supplement') && <>
      <div className="row between" style={{ marginBottom: 8 }}><span>{nt('Servings to log')}</span><Stepper value={qty} step={mode === 'supplement' ? 1 : 0.5} min={0.01} max={1000} onChange={setQty} ariaLabel={nt('Servings to log')} /></div>
      <Button variant="primary" onClick={() => run({ save: true, log: true })} disabled={busy}>{nt('Save and add to {0}', nt(MEAL_LABEL[logMeal]).toLowerCase())}</Button>
      <div style={{ height: 8 }} />
      <div className="nut-ai-row" style={{ margin: 0 }}>
        <Button onClick={() => run({ save: false, log: true })} disabled={busy}>{nt('Only add to {0}', nt(MEAL_LABEL[logMeal]).toLowerCase())}</Button>
        <Button onClick={() => run({ save: true, log: false })} disabled={busy}>{supplement ? nt('Only save to My supplements') : nt('Only save to My foods')}</Button>
      </div>
    </>}
    {!dup && mode === 'fill' && <Button variant="primary" onClick={() => { onUse?.(f); close() }}>{nt('Use these values')}</Button>}
    {!dup && mode === 'entry' && <Button variant="primary" onClick={applyToEntry} disabled={busy || !Object.keys(entryMicros(f, qty)).length}>{nt('Add to this entry')}</Button>}
    <div style={{ height: 6 }} />
    <Button variant="ghost" className="dim" onClick={close}>{nt('Cancel')}</Button>
  </>
}

/* ------------------------------ the flow ------------------------------ */

/**
 * @param {{ mode:'food'|'supplement'|'fill'|'entry', date?:string, meal?:string, entry?:object, hint?:string, upc?:string,
 *           initial?:object, source?:string, onBack:()=>void, onSaved?:()=>void, onUse?:(form:object)=>void, onApplied?:(out:object)=>void, close:()=>void }} p
 */
export default function LabelFlow({ mode, date, meal, entry, hint, upc, initial = null, source = 'label', onBack, onSaved, onUse, onApplied, close }) {
  const [ai, setAi] = useAi()
  const [read, setRead] = useState(initial ? { form: initial, label: null } : null)
  const title = mode === 'supplement' ? nt('Photo of the label') : nt('Scan a label')
  if (read) return <Review initial={read.form} label={read.label} source={read.source || source} mode={mode} date={date} meal={meal} entry={entry}
    onBack={() => (initial ? onBack() : setRead(null))} onSaved={onSaved} onUse={onUse} onApplied={onApplied} close={close} />
  const hintOf = hint || (mode === 'supplement' ? 'supplement' : mode === 'entry' ? 'auto' : 'food')
  return <Capture hint={hintOf} upc={upc} title={title} ai={ai} onAi={setAi} onBack={onBack}
    onRead={(label, code) => { const form = formOf(label); if (code && !form.upc) form.upc = code; setRead({ form, label, source: 'label' }) }} />
}

/** Open the label flow in a sheet of its own (food form, Edit entry, the fill-in sheet). */
export const openLabelSheet = props => useUI.getState().openSheet(close => <LabelFlow {...props} onBack={close} close={close} />)
