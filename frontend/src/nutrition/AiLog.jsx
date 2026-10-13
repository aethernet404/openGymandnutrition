// Photo / Describe → AI estimate → an EDITABLE draft → Save. Three promises, each enforced in code
// rather than by wording:
//   · nothing reaches the diary until Save is pressed (the only addEntries call is in `save`);
//   · the photo exists only in this component's memory (a shrunken JPEG, never stored);
//   · whenever the AI cannot help — cap, timeout, auth, down, unreadable — there is a way on to
//     logging by hand, with whatever the person already typed carried over.
import { useEffect, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, SelectRow, TextArea, TextField } from '../components/ui.jsx'
import { useUI } from '../store/useUI.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { downscaleToJpeg } from './image.js'
import { CONFIDENCE_LABEL, allowanceText, blankRow, draftRows, draftToEntries, edited, failureAdvice, rowsTotals } from './ai.js'
import { MEALS, MEAL_LABEL, macroLine } from './diary.js'
import { MacroFields } from './sheets.jsx'
import { confirmSheet } from '../sheets.jsx'

const toast = m => useUI.getState().toast(m)

function Review({ draft, date, initialMeal, onSaved, onDiscard, close }) {
  const [rows, setRows] = useState(() => draftRows(draft))
  const [name, setName] = useState(draft.name || '')
  const [meal, setMeal] = useState(initialMeal)
  const [busy, setBusy] = useState(false)
  const next = useRef(rows.length)
  const totals = rowsTotals(rows)
  const change = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = async () => {
    const r = draftToEntries(rows, { date, meal, confidence: draft.confidence })
    if (!r.ok) { toast(nt(r.error)); return }
    setBusy(true)
    try { await nutri.addEntries(r.body); onSaved(); close(); toast(nt('Saved to {0}', nt(MEAL_LABEL[meal]).toLowerCase())) }
    catch (e) { toast(e.message); setBusy(false) }
  }

  return <>
    <h3>{nt('Check the estimate')}</h3>
    <div className="nut-banner info"><Icon name="sparkles" /><span>{nt('This is an AI estimate. Fix anything that looks wrong; nothing is saved until you press Save.')}</span></div>
    <div className="row between" style={{ margin: '12px 0 4px' }}>
      <TextField value={name} maxLength={80} placeholder={nt('Meal name')} onChange={e => setName(e.target.value)} aria-label={nt('Meal name')} />
    </div>
    <div className="nut-conf-row">
      <span className={'tag nut-conf ' + draft.confidence}>{nt(CONFIDENCE_LABEL[draft.confidence])}</span>
      {draft.notes && <span className="muted small">{draft.notes}</span>}
    </div>
    {draft.warnings?.length > 0 && <div className="nut-banner warn"><Icon name="warning" /><span>{draft.warnings.map(w => nt(w)).join(' · ')}</span></div>}

    {rows.map((r, i) => <div key={r.key} className="nut-item">
      <div className="row" style={{ gap: 8 }}>
        <TextField value={r.name} maxLength={80} placeholder={nt('Food')} onChange={e => change(i, { name: e.target.value })} aria-label={nt('Food name')} />
        <button className="iconbtn" style={{ color: 'var(--red)' }} onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} aria-label={nt('Remove this item')}><Icon name="trash" /></button>
      </div>
      <div className="nut-fields" style={{ margin: '8px 0' }}>
        <label className="nut-field"><span>{nt('Portion')}</span><span className="nut-input"><TextField value={r.portion} maxLength={80} placeholder={nt('e.g. 1 cup')} onChange={e => change(i, { portion: e.target.value })} aria-label={nt('Portion')} /></span></label>
        <label className="nut-field"><span>{nt('Weight')}</span><span className="nut-input"><NumberField nullable value={r.grams} onChange={g => change(i, { grams: g })} aria-label={nt('Weight in grams')} /><i>g</i></span></label>
      </div>
      <MacroFields v={r} set={nv => change(i, nv)} />
    </div>)}
    <Button size="sm" icon="plus" onClick={() => setRows(rs => [...rs, blankRow(next.current++)])}>{nt('Add an item')}</Button>

    <div className="nut-preview" style={{ margin: '14px 0' }}><b>{totals.calories}</b> kcal<span className="muted"> · {macroLine(totals)}</span></div>
    <SelectRow title={nt('Meal')} sheetTitle={nt('Meal')} value={meal} onChange={setMeal} options={MEALS.map(m => ({ value: m, label: nt(MEAL_LABEL[m]) }))} />
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={save} disabled={busy || !rows.length}>{nt('Save to diary')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={() => (edited(draft, rows) ? onDiscard(true) : onDiscard(false))}>{nt('Discard')}</Button>
  </>
}

function Problem({ error, mode, onRetry, onDescribe, onManual }) {
  const adv = failureAdvice(error.code)
  return <>
    <div className="nut-banner warn"><Icon name="warning" /><span>{error.message}</span></div>
    {error.ai && <div className="muted small" style={{ margin: '8px 2px 0' }}>{nt(allowanceText(error.ai))}</div>}
    <div style={{ height: 12 }} />
    {adv.retry && <><Button onClick={onRetry}>{nt('Try again')}</Button><div style={{ height: 8 }} /></>}
    {adv.describe && mode === 'photo' && <><Button onClick={onDescribe}>{nt('Describe it instead')}</Button><div style={{ height: 8 }} /></>}
    {adv.manual && <Button variant={adv.retry ? 'ghost' : 'primary'} onClick={onManual}>{nt('Log it by hand')}</Button>}
  </>
}

/**
 * @param {{ mode:'photo'|'text', date:string, meal:string, ai:object|null, onAi:(a:object)=>void,
 *           onBack:()=>void, onSaved:()=>void, onManual:(name:string)=>void, close:()=>void }} p
 */
export default function AiLog({ mode: initialMode, initialText = '', date, meal, ai, onAi, onBack, onSaved, onManual, close }) {
  const [mode, setMode] = useState(initialMode)
  const [stage, setStage] = useState('pick')       // pick | prep | busy | review | error | notfood
  const [photo, setPhoto] = useState(null)         // { base64, bytes, previewUrl }
  const [note, setNote] = useState('')
  const [text, setText] = useState(initialText)
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState(null)
  const alive = useRef(true)
  const camera = useRef(null)
  const gallery = useRef(null)
  const preview = useRef(null)
  useEffect(() => () => { alive.current = false; if (preview.current) URL.revokeObjectURL(preview.current) }, [])

  const choose = async file => {
    if (!file) return
    setStage('prep'); setError(null)
    try {
      const p = await downscaleToJpeg(file)
      if (!alive.current) { URL.revokeObjectURL(p.previewUrl); return }
      if (preview.current) URL.revokeObjectURL(preview.current)
      preview.current = p.previewUrl
      setPhoto(p); setStage('pick')
    } catch (e) { if (alive.current) { setError({ code: 'client', message: e.message }); setStage('error') } }
  }

  const run = async () => {
    setStage('busy'); setError(null)
    try {
      const r = await nutri.analyze(mode === 'photo' ? { kind: 'photo', image: photo.base64, note } : { kind: 'text', text })
      if (!alive.current) return
      if (r.ai) onAi(r.ai)
      if (r.draft.notFood) { setDraft(r.draft); setStage('notfood'); return }
      setDraft(r.draft); setStage('review')
    } catch (e) {
      if (!alive.current) return
      const code = e.code === 'timeout' ? 'client-timeout' : e.data?.code || 'provider'
      if (e.data?.ai) onAi(e.data.ai)
      setError({
        code, ai: e.data?.ai || null,
        message: code === 'client-timeout' ? nt('No answer yet. The analysis may still finish on the server and count against today’s limit.') : e.status === 0 || e.code === 'bad-response' || !e.status ? nt('Could not reach the server: {0}', e.message) : e.message
      })
      setStage('error')
    }
  }

  const manualName = mode === 'text' ? text.trim() : note.trim()
  const canRun = mode === 'photo' ? !!photo : text.trim().length >= 2

  if (stage === 'review') return <Review draft={draft} date={date} initialMeal={meal} onSaved={onSaved} close={close}
    onDiscard={changed => (changed ? confirmSheet({ title: nt('Discard your changes?'), message: nt('The estimate and your edits will be thrown away. Nothing has been saved.'), confirmText: nt('Discard'), danger: true, onConfirm: onBack }) : onBack())} />

  return <>
    <button className="nut-back" onClick={onBack}><Icon name="chevronLeft" />{nt('Back')}</button>
    <h3>{mode === 'photo' ? nt('Log from a photo') : nt('Describe your meal')}</h3>

    {stage === 'busy' && <div className="nut-busy">
      <div className="nut-spinner" aria-hidden="true" />
      <div>{nt('Analyzing…')}</div>
      <div className="muted small">{nt('Usually 5 to 15 seconds.')}</div>
    </div>}

    {stage === 'notfood' && <>
      <div className="nut-banner info"><Icon name="info" /><span>{nt('That does not look like food.')} {draft?.notes}</span></div>
      <div style={{ height: 12 }} />
      <Button onClick={() => { setDraft(null); setStage('pick'); setPhoto(null) }}>{nt('Try another')}</Button>
      <div style={{ height: 8 }} />
      <Button variant="ghost" onClick={() => onManual(manualName)}>{nt('Log it by hand')}</Button>
    </>}

    {stage === 'error' && <Problem error={error} mode={mode}
      onRetry={() => (canRun ? run() : setStage('pick'))}
      onDescribe={() => { setMode('text'); setText(note); setStage('pick') }}
      onManual={() => onManual(manualName)} />}

    {(stage === 'pick' || stage === 'prep') && <>
      {mode === 'photo' ? <>
        {photo ? <div className="nut-photo"><img src={photo.previewUrl} alt={nt('Your meal')} /></div>
          : <div className="nut-photo empty">{stage === 'prep' ? nt('Preparing the photo…') : <Icon name="camera" />}</div>}
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} />
        <input ref={gallery} type="file" accept="image/*" hidden onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} />
        <div className="row" style={{ gap: 8, margin: '10px 0' }}>
          <Button icon="camera" style={{ flex: 1 }} onClick={() => camera.current?.click()} disabled={stage === 'prep'}>{nt('Take photo')}</Button>
          <Button icon="image" style={{ flex: 1 }} onClick={() => gallery.current?.click()} disabled={stage === 'prep'}>{nt('Gallery')}</Button>
        </div>
        <TextField value={note} maxLength={300} placeholder={nt('Anything the photo can’t show? (optional)')} onChange={e => setNote(e.target.value)} aria-label={nt('Note')} />
      </> : <TextArea rows={3} maxLength={500} value={text} placeholder={nt('e.g. two eggs and a slice of buttered toast')} onChange={e => setText(e.target.value)} aria-label={nt('Describe your meal')} />}
      <div className="muted small" style={{ margin: '10px 2px' }}>
        {mode === 'photo' ? nt('The photo is shrunk on your device, sent to Claude through this server’s account, and not stored.') : nt('Your description is sent to Claude through this server’s account.')} {nt(allowanceText(ai))}
      </div>
      <Button variant="primary" icon="sparkles" onClick={run} disabled={!canRun || stage === 'prep'}>{nt('Estimate calories & macros')}</Button>
      <div style={{ height: 8 }} />
      <Button variant="ghost" className="dim" onClick={() => onManual(manualName)}>{nt('Log it by hand instead')}</Button>
    </>}
  </>
}
