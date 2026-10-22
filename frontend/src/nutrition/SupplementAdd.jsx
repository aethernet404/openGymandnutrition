// Add a supplement: four ways in. Scan its barcode, photograph its Supplement Facts, search the NIH label database by name, or
// type it. The barcode is looked up in this order, stopping at the first hit: my own saved supplements, the NIH Dietary Supplement
// Label Database, then Open Food Facts and USDA Branded (the server does the walking; this shows what it found). Whatever
// comes back is reviewed in the same sheet as a label photo and saved only when a button is pressed.
import { useEffect, useRef, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { Button, SearchField, Stepper } from '../components/ui.jsx'
import { MOBILE } from '../lib/mobile.js'
import { useUI } from '../store/useUI.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import LabelFlow from './LabelFlow.jsx'
import { formOfHit } from './labelForm.js'
import { gtinCheckOk, scanMethods } from './barcode.js'
import { ScanPanel } from './sheets.jsx'

const toast = m => useUI.getState().toast(m)
export const NIH_NAME = 'NIH Office of Dietary Supplements, Dietary Supplement Label Database (DSLD)'
export const NIH_URL = 'https://dsld.od.nih.gov/'
export const NihCredit = () => <div className="muted small nut-lab-credit">{nt('Label data: {0}. Public domain.', NIH_NAME)} <a href={NIH_URL} target="_blank" rel="noreferrer noopener">dsld.od.nih.gov</a></div>

/** A supplement I already saved with this barcode: log it without any review. */
function SavedHit({ hit, date, onBack, onDone }) {
  const [qty, setQty] = useState(1)
  const [busy, setBusy] = useState(false)
  const add = async () => {
    setBusy(true)
    try { await nutri.addEntries({ date, meal: 'supplements', source: 'food', foodId: hit.ext, qty }); onDone(); toast(nt('Added')) } catch (e) { toast(e?.message || nt('Something went wrong')); setBusy(false) }
  }
  return <>
    <button className="nut-back" onClick={onBack}><Icon name="chevronLeft" />{nt('Back')}</button>
    <div className="nut-banner info"><Icon name="info" /><span>{nt('You already saved this one.')}</span></div>
    <div className="nut-picked"><b>{hit.name}</b>{hit.brand && <span className="muted"> · {hit.brand}</span>}</div>
    <div className="muted small">{nt('One serving: {0}', hit.bases?.[0]?.label || nt('1 serving'))}</div>
    <div className="row between" style={{ margin: '12px 0 8px' }}><span>{nt('Servings')}</span><Stepper value={qty} step={1} min={0.5} max={100} onChange={setQty} ariaLabel={nt('Servings')} /></div>
    <Button variant="primary" onClick={add} disabled={busy}>{nt('Add to supplements')}</Button>
  </>
}

const FROM = { dsld: 'the NIH supplement database', off: 'Open Food Facts', usda: 'USDA Branded Foods' }

function BarcodeView({ date, onBack, onDone, close }) {
  const [methods, setMethods] = useState({ photo: true, type: true, live: null })
  const [res, setRes] = useState(null)               // { status:'loading'|'error'|'done', code, data?, error? }
  const [label, setLabel] = useState(null)           // { initial, source } | { upc } (photograph instead)
  const seq = useRef(0)
  useEffect(() => { let live = true; scanMethods({ mobile: MOBILE }).then(m => live && setMethods(m)); return () => { live = false } }, [])
  const lookup = async code => {
    const n = ++seq.current
    setRes({ status: 'loading', code })
    try { const data = await nutri.lookupBarcode(code, 'supplement'); if (n === seq.current) setRes({ status: 'done', code, data, warn: !gtinCheckOk(code) }) }
    catch (e) { if (n === seq.current) setRes({ status: 'error', code, error: e?.message || nt('Something went wrong') }) }
  }
  if (label?.initial) return <LabelFlow mode="supplement" date={date} initial={label.initial} source={label.source} onBack={() => setLabel(null)} onSaved={onDone} close={close} />
  if (label) return <LabelFlow mode="supplement" date={date} upc={label.upc} onBack={() => setLabel(null)} onSaved={onDone} close={close} />
  const d = res?.data
  if (d?.found && d.via === 'mine') return <SavedHit hit={d.product} date={date} onBack={() => setRes(null)} onDone={onDone} />
  return <>
    <button className="nut-back" onClick={onBack}><Icon name="chevronLeft" />{nt('Back')}</button>
    <h3>{nt('Scan barcode')}</h3>
    <ScanPanel methods={methods} onCode={lookup} onTyped={lookup} />
    {res?.status === 'loading' && <div className="muted small nut-empty">{nt('Looking up the barcode…')}</div>}
    {res?.status === 'error' && <div className="nut-banner warn" role="alert"><Icon name="warning" /><span>{res.error}</span><button className="linkbtn" onClick={() => lookup(res.code)}>{nt('Try again')}</button></div>}
    {d?.found && <div className="nut-banner info"><Icon name="info" /><span>{nt('Found {0} in {1}.', d.product.name, nt(FROM[d.via] || 'a database'))}</span></div>}
    {d?.found && <Button variant="primary" onClick={() => setLabel({ initial: formOfHit({ ...d.product, upc: d.product.upc || res.code }), source: d.via })}>{nt('Check and add it')}</Button>}
    {d?.found && d.via === 'dsld' && <NihCredit />}
    {d && !d.found && <>
      <div className="nut-banner info"><Icon name="info" /><span>{d.incomplete ? nt('Barcode {0} was not found, but a database could not be reached, so it may still exist.', res.code) : nt('Barcode {0} is not in any supplement database we can ask.', res.code)}{res.warn ? ' ' + nt('Its check digit does not add up, so look for a typo.') : ''}{d.tried?.some(t => t.note) ? ' ' + nt('NIH has similar products but not this barcode.') : ''}</span></div>
      <Button variant="primary" icon="camera" onClick={() => setLabel({ upc: res.code })}>{nt('Photograph the label instead')}</Button>
    </>}
  </>
}

function SearchView({ date, onBack, onDone, close }) {
  const [text, setText] = useState('')
  const [list, setList] = useState(null)             // null | 'loading' | [] | array
  const [err, setErr] = useState('')
  const [label, setLabel] = useState(null)
  const [opening, setOpening] = useState(false)
  const run = async () => {
    const t = text.trim()
    if (t.length < 3) return
    setList('loading'); setErr('')
    try { const r = await nutri.searchSupplements(t); setList(r.results || []) } catch (e) { setList(null); setErr(e?.message || nt('Something went wrong')) }
  }
  const open = async h => {
    setOpening(true); setErr('')
    try { const r = await nutri.getSupplementLabel(h.id); setLabel(formOfHit(r.product)) } catch (e) { setErr(e?.message || nt('Something went wrong')) }
    setOpening(false)
  }
  if (label) return <LabelFlow mode="supplement" date={date} initial={label} source="dsld" onBack={() => setLabel(null)} onSaved={onDone} close={close} />
  return <>
    <button className="nut-back" onClick={onBack}><Icon name="chevronLeft" />{nt('Back')}</button>
    <h3>{nt('Search supplements')}</h3>
    <SearchField value={text} onChange={e => setText(e.target.value)} onClear={() => { setText(''); setList(null) }} placeholder={nt('Brand or product name')} onKeyDown={e => { if (e.key === 'Enter') run() }} />
    <div style={{ height: 8 }} />
    <Button onClick={run} disabled={text.trim().length < 3 || list === 'loading'}>{nt('Search')}</Button>
    {list === 'loading' && <div className="muted small nut-empty">{nt('Searching…')}</div>}
    {opening && <div className="muted small nut-empty">{nt('Loading the label…')}</div>}
    {err && <div className="nut-banner warn" role="alert"><Icon name="warning" /><span>{err}</span></div>}
    {Array.isArray(list) && list.length === 0 && <div className="muted small nut-empty">{nt('Nothing found. Try fewer words, or photograph the label.')}</div>}
    <div className="nut-pick-list">
      {Array.isArray(list) && list.map(h => <button key={h.id} className="nut-pick" onClick={() => open(h)} disabled={opening}>
        <span className="nut-pick-m"><span className="nut-pick-t">{h.name}</span><span className="nut-pick-s">{h.brand}{h.offMarket ? ' · ' + nt('off the market') : ''}</span></span>
      </button>)}
    </div>
    <NihCredit />
  </>
}

/** The "New" tab of Vitamins & supplements. `manual` is the existing typed form. */
export default function SupplementAdd({ date, onDone, close, manual }) {
  const [view, setView] = useState('menu')           // menu | barcode | photo | search | manual
  const back = () => setView('menu')
  if (view === 'barcode') return <BarcodeView date={date} onBack={back} onDone={onDone} close={close} />
  if (view === 'photo') return <LabelFlow mode="supplement" date={date} onBack={back} onSaved={onDone} close={close} />
  if (view === 'search') return <SearchView date={date} onBack={back} onDone={onDone} close={close} />
  if (view === 'manual') return <>
    <button className="nut-back" onClick={back}><Icon name="chevronLeft" />{nt('Back')}</button>
    {manual}
  </>
  return <div className="nut-lab-menu">
    <Button icon="qr" onClick={() => setView('barcode')}>{nt('Scan barcode')}</Button>
    <Button icon="camera" onClick={() => setView('photo')}>{nt('Photo of the label')}</Button>
    <Button onClick={() => setView('search')}>{nt('Search')}</Button>
    <Button icon="pencil" onClick={() => setView('manual')}>{nt('Manual')}</Button>
    <div className="muted small">{nt('A barcode is looked up in your saved supplements first, then the NIH supplement label database, then Open Food Facts and USDA. If none has it, photograph the label.')}</div>
  </div>
}
