// "Fill in micronutrients": entries with no vitamins or minerals get a USDA FoodData Central stand-in. The AI only picks
// which USDA food is closest (the server asks it once for the whole batch); every amount shown here comes from USDA,
// scaled to the entry's portion, and is stored marked as an estimate. Nothing is saved until Accept is pressed.
import { useEffect, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { useUI } from '../store/useUI.js'
import { dateLocale } from '../lib/i18n.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { allowanceText, unavailableText } from './ai.js'
import { NUTRIENTS, amountText, canFill, diffText } from './micros.js'

const toast = m => useUI.getState().toast(m)
const BATCH = 12                       // the server asks the model once per this many entries
export const CONFIDENCE_WORD = { low: 'low', medium: 'medium', high: 'high' }

/** What the log-time option and the sheets need to know: is the AI there, has it allowance left, does the server have the USDA key. */
export function useFillAvailability() {
  const [a, setA] = useState(null)
  useEffect(() => {
    let live = true
    Promise.resolve(nutri.getConfig()).then(c => { if (live && c) setA({ ai: c.ai || null, usda: !!c.lookup?.usda }) }).catch(() => {})
    return () => { live = false }
  }, [])
  const ok = !!a && !!a.usda && !!a.ai?.available && a.ai.remaining > 0
  const why = !a ? null : !a.usda ? nt('Needs the USDA key (an admin adds it under Goals → Admin).') : !a.ai?.available ? nt(unavailableText(a.ai?.reason)) : a.ai.remaining <= 0 ? nt('You have used all of today’s AI analyses.') : null
  return { ...(a || {}), ok, why, ready: !!a }
}

/** The optional "look up vitamins and minerals when I save" box on the add screens. Off unless ticked. */
export function FillOption({ checked, onChange, disabled = false }) {
  const f = useFillAvailability()
  if (!f.ready) return null
  const off = !f.ok || disabled
  return <div className="nut-fill-opt">
    <label className={off ? 'off' : ''}>
      <input type="checkbox" checked={checked && !off} disabled={off} onChange={e => onChange(e.target.checked)} />
      <span>{nt('Look up vitamins and minerals from USDA')}</span>
    </label>
    <div className="muted small">{off ? (f.why || '') : nt('After saving, the AI picks the closest USDA food and you review the amounts before anything is added. Uses 1 AI analysis. {0}', nt(allowanceText(f.ai)))}</div>
  </div>
}

function Amounts({ micros }) {
  const locale = dateLocale()
  const rows = NUTRIENTS.filter(n => micros[n.key] != null)
  return <ul className="nut-fill-amounts">
    {rows.map(n => <li key={n.key}><span>{nt(n.label)}</span><b>{amountText(n.key, micros[n.key], locale)}</b></li>)}
  </ul>
}

function Differences({ diffs }) {
  if (!diffs?.length) return null
  return <div className="nut-banner warn nut-fill-warn" role="alert"><Icon name="warning" /><span>
    {diffs.map(d => { const x = diffText(d); return <span key={d.key} className="nut-fill-diff">{nt('This stand-in has {0} {1} ({2}; you logged {3}).', nt(x.how), nt(x.what), x.numbers, x.logged)} </span> })}
    {nt('Pick another candidate or cancel if it is not a fair stand-in.')}
  </span></div>
}

function Candidates({ list, shownId, busy, onPick }) {
  const others = list.filter(c => c.fdcId !== shownId)
  if (!others.length) return <div className="muted small">{nt('There are no other candidates.')}</div>
  return <div className="nut-fill-cands">
    {others.map(c => <button key={c.fdcId} type="button" className="nut-fill-cand" disabled={busy} onClick={() => onPick(c)}>
      <span>{c.name}{c.brand ? ` · ${c.brand}` : ''}</span><span className="muted small">{c.dataType}</span>
    </button>)}
  </div>
}

/** One entry's proposal: what would be used, what it would add, and the three choices. */
function Card({ item, entry, date, onItem }) {
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const shown = item.alt || item.preview
  const mine = !item.alt && item.status === 'match'
  const conf = mine ? item.confidence : null
  const set = patch => onItem(item.id, patch)

  const choose = async c => {
    setBusy(true)
    try { const r = await nutri.previewMicros(date, item.id, c.fdcId); set({ alt: r.preview }); setChoosing(false) } catch (e) { toast(e?.message || nt('Something went wrong')) }
    setBusy(false)
  }
  const accept = async () => {
    setBusy(true)
    try { await nutri.applyMicros(date, item.id, { fdcId: shown.fdcId, ...(conf ? { confidence: conf } : {}) }); set({ state: 'accepted' }) } catch (e) { toast(e?.message || nt('Something went wrong')); setBusy(false) }
  }

  if (item.state === 'accepted') return <div className="nut-fill-card done"><b>{entry.name}</b><div className="small"><Icon name="check" /> {nt('Saved as an estimate from USDA {0}.', shown.name)}</div></div>
  if (item.state === 'skipped') return <div className="nut-fill-card done"><b>{entry.name}</b><div className="muted small">{nt('Left as it was.')}</div></div>
  if (item.status === 'skipped') return <div className="nut-fill-card done"><b>{entry.name}</b><div className="muted small">{nt(SKIP_TEXT[item.why] || 'Skipped.')}</div></div>

  const canAccept = !!shown?.ok && !shown.empty
  const warn = !!shown?.diffs?.length
  return <div className="nut-fill-card">
    <b className="nut-fill-name">{entry.name}</b>{entry.brand && <span className="muted small"> · {entry.brand}</span>}
    {!shown && <>
      <div className="nut-banner info"><Icon name="info" /><span>{nt('No good USDA match.')} {item.reason}</span></div>
      {item.candidates?.length > 0 && !choosing && <Button size="sm" onClick={() => setChoosing(true)}>{nt('Choose one myself')}</Button>}
    </>}
    {shown && <>
      <div className="nut-fill-using">{nt('Using USDA {0} ({1}) as a stand-in', shown.name, shown.dataType)}{conf ? ', ' + nt('confidence {0}', nt(CONFIDENCE_WORD[conf])) : ', ' + nt('chosen by you')}</div>
      {mine && item.reason && <div className="muted small nut-fill-reason">{item.reason}</div>}
      {shown.ok
        ? <>
          <div className="muted small">{shown.how === 'entry' ? nt('For {0} g, the weight you logged.', shown.grams) : nt('For about {0} g, worked out from the calories.', shown.grams)}</div>
          <Differences diffs={shown.diffs} />
          {shown.empty
            ? <div className="muted small">{nt('This USDA food has no vitamins or minerals beyond what you already have.')}</div>
            : <><div className="nut-fill-h">{nt('Would add (estimates)')}</div><Amounts micros={shown.micros} />
              {shown.alreadyKnown?.length > 0 && <div className="muted small">{nt('{0} values you already have are kept as they are.', shown.alreadyKnown.length)}</div>}</>}
        </>
        : <div className="nut-banner warn"><Icon name="warning" /><span>{shown.why}</span></div>}
    </>}
    {choosing && <Candidates list={item.candidates || []} shownId={shown?.fdcId} busy={busy} onPick={choose} />}
    <div className="nut-fill-actions">
      {shown && <Button variant="primary" size="sm" onClick={accept} disabled={busy || !canAccept}>{warn ? nt('Accept anyway') : nt('Accept')}</Button>}
      {item.candidates?.length > 0 && shown && <Button size="sm" onClick={() => setChoosing(c => !c)} disabled={busy}>{nt('Choose another')}</Button>}
      <Button size="sm" variant="ghost" onClick={() => set({ state: 'skipped' })} disabled={busy}>{nt('Cancel')}</Button>
    </div>
  </div>
}

const SKIP_TEXT = {
  'has-data': 'Already has its own vitamins or minerals, so nothing to fill in.',
  estimated: 'Already has an estimate.', supplement: 'Supplements are not estimated.', 'no-name': 'Has no name to look up.', missing: 'Could not be found.'
}

function FillSheet({ date, entries, replace, onDone, close }) {
  const todo = entries.filter(e => replace || canFill(e))
  const f = useFillAvailability()
  const [stage, setStage] = useState('intro')            // intro | busy | review | error
  const [items, setItems] = useState([])
  const [error, setError] = useState(null)
  const [ai, setAi] = useState(null)
  const alive = useRef(true)
  const changed = useRef(false)
  useEffect(() => () => { alive.current = false }, [])
  const byId = Object.fromEntries(todo.map(e => [e.id, e]))
  const batches = Math.max(1, Math.ceil(todo.length / BATCH))

  const run = async () => {
    setStage('busy'); setError(null)
    const got = []
    try {
      for (let i = 0; i < todo.length; i += BATCH) {
        const r = await nutri.matchMicros(date, todo.slice(i, i + BATCH).map(e => e.id), replace)
        if (!alive.current) return
        got.push(...r.results.map(x => ({ ...x, state: 'open' })))
        if (r.ai) setAi(r.ai)
      }
    } catch (e) {
      if (!alive.current) return
      if (e.data?.ai) setAi(e.data.ai)
      if (!got.length) { setError(e.message || nt('Something went wrong')); setStage('error'); return }
      toast(nt('Some entries could not be checked: {0}', e.message))
    }
    setItems(got); setStage('review')
  }
  const onItem = (id, patch) => {
    if (patch.state === 'accepted') { changed.current = true; onDone?.() }
    setItems(list => list.map(x => (x.id === id ? { ...x, ...patch } : x)))
  }
  const left = items.filter(x => x.state === 'open' && x.status !== 'skipped').length

  return <>
    <div className="row between nut-fill-head">
      <h3>{nt('Fill in micronutrients')}</h3>
      <button type="button" className="iconbtn" onClick={close} aria-label={nt('Close')}><Icon name="xmark" /></button>
    </div>

    {stage === 'intro' && <>
      <div className="nut-banner info"><Icon name="info" /><span>{nt('The AI picks the closest USDA FoodData Central food for each entry below. The vitamins and minerals come from USDA, scaled to your portion, and are marked as estimates. You review every one; nothing is saved until you accept.')}</span></div>
      <ul className="nut-fill-list">{todo.slice(0, 12).map(e => <li key={e.id}>{e.name}</li>)}{todo.length > 12 && <li className="muted">{nt('and {0} more', todo.length - 12)}</li>}</ul>
      <div className="muted small nut-fill-priv">{nt('Only the food names, brands, amounts, calories and macros are sent to the AI, and only names to USDA. Uses {0} of your AI analyses (1 for each 12 entries). {1}', batches, f.ai ? nt(allowanceText(f.ai)) : '')}</div>
      {f.ready && !f.ok && <div className="nut-banner warn"><Icon name="warning" /><span>{f.why}</span></div>}
      <div style={{ height: 12 }} />
      <Button variant="primary" icon="sparkles" onClick={run} disabled={!todo.length || (f.ready && !f.ok)}>{nt('Find stand-ins')}</Button>
      <div style={{ height: 8 }} />
      <Button variant="ghost" className="dim" onClick={close}>{nt('Cancel')}</Button>
    </>}

    {stage === 'busy' && <div className="nut-busy"><div className="nut-spinner" aria-hidden="true" /><div>{nt('Looking in USDA FoodData Central…')}</div><div className="muted small">{nt('Usually 5 to 20 seconds.')}</div></div>}

    {stage === 'error' && <>
      <div className="nut-banner warn" role="alert"><Icon name="warning" /><span>{error}</span></div>
      {ai && <div className="muted small" style={{ margin: '8px 2px 0' }}>{nt(allowanceText(ai))}</div>}
      <div style={{ height: 12 }} />
      <Button onClick={run}>{nt('Try again')}</Button>
      <div style={{ height: 8 }} />
      <Button variant="ghost" className="dim" onClick={close}>{nt('Close')}</Button>
    </>}

    {stage === 'review' && <>
      {ai && <div className="muted small" style={{ margin: '0 2px 8px' }}>{nt(allowanceText(ai))}</div>}
      {items.map(it => byId[it.id] && <Card key={it.id} item={it} entry={byId[it.id]} date={date} onItem={onItem} />)}
      <div style={{ height: 8 }} />
      <Button variant={left ? 'ghost' : 'primary'} className={left ? 'dim' : ''} onClick={close}>{left ? nt('Cancel the rest') : nt('Done')}</Button>
    </>}
  </>
}

/** @param {{ date:string, entries:object[], replace?:boolean, onDone?:()=>void }} p  onDone runs after each accepted estimate (the screen behind reloads). */
export const openFillMicros = p => useUI.getState().openSheet(close => <FillSheet {...p} replace={!!p.replace} close={close} />)
