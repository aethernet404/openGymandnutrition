// The Micronutrients card under the diary's macro summary: closed until tapped, then each known nutrient with its amount
// and its percent of the FDA Daily Value, grouped Vitamins / Minerals / Other, a coverage line that says how much of the
// day it is based on, a Food only / Food + supplements switch, and (neutral, always visible) a note for anything above the
// usual adult upper limit. Nutrients nobody knows are listed as unknown, never drawn as zero.
import { useState } from 'react'
import Icon from '../components/Icon.jsx'
import { Button, Segmented, Switch } from '../components/ui.jsx'
import { dateLocale } from '../lib/i18n.js'
import { nt } from './i18n.js'
import { openFillMicros } from './FillMicros.jsx'
import { amountText, canFill, coverageGroups, groupedRows, pick, upperLimitNotes } from './micros.js'

const MODE_KEY = 'nut_micros_mode'
const readMode = () => { try { return localStorage.getItem(MODE_KEY) === 'food' ? 'food' : 'all' } catch { return 'all' } }
const writeMode = m => { try { localStorage.setItem(MODE_KEY, m) } catch { /* a per-device convenience only */ } }
// "Include estimated values": remembered on this device, on unless it was turned off.
const EST_KEY = 'nut_micros_est'
const readEst = () => { try { return localStorage.getItem(EST_KEY) !== 'off' } catch { return true } }
const writeEst = on => { try { localStorage.setItem(EST_KEY, on ? 'on' : 'off') } catch { /* a per-device convenience only */ } }

export function MicroBar({ pct }) {
  const over = pct > 100
  return <div className={'nut-mbar' + (over ? ' over' : '')} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={nt('{0}% of the Daily Value', pct)}>
    <i style={{ width: Math.min(100, pct) + '%' }} />
  </div>
}

export default function MicrosCard({ micros, entries = [], date, onChanged }) {
  const [open, setOpen] = useState(false)
  const [mode, setModeState] = useState(readMode)
  const setMode = m => { setModeState(m); writeMode(m) }
  const [est, setEstState] = useState(readEst)
  const setEst = on => { setEstState(on); writeEst(on) }
  if (!micros) return null
  const locale = dateLocale()
  const p = pick(micros, mode, est)
  const cov = coverageGroups(p)
  const groups = groupedRows(p.totals, p.marked)
  const notes = upperLimitNotes(micros, locale, est)     // from everything eaten and taken, whichever way the card is showing it
  const fillable = entries.filter(canFill)

  return <div className="card nut-micros">
    <button type="button" className="nut-micros-h" onClick={() => setOpen(o => !o)} aria-expanded={open}>
      <span><b>{nt('Micronutrients')}</b>{cov && !open && <span className="muted small"> · {cov.nothing ? nt('no data yet') : nt('{0} of {1} entries', cov.counted, cov.entries)}</span>}</span>
      <Icon name={open ? 'chevronUp' : 'chevronDown'} />
    </button>

    {notes.length > 0 && <ul className="nut-ul-notes">
      {notes.map(n => <li key={n.key}>
        {nt('{0}: {1} today{2} is above the usual upper limit for adults ({3}{4}). Worth checking with a doctor or pharmacist.', nt(n.label), n.amount, n.scope === 'supplement' ? ' ' + nt('from supplements') : '', n.limit, n.note ? '; ' + nt(n.note) : '')}{n.estimated && ' ' + nt('This includes estimated values.')}
      </li>)}
    </ul>}

    {open && <div className="nut-micros-b">
      <Segmented value={mode} onChange={setMode} options={[{ value: 'food', label: nt('Food only') }, { value: 'all', label: nt('Food + supplements') }]} />
      <div className="muted small nut-cov" role="status">
        {!cov ? nt('Nothing logged for this day yet.')
          : <>{nt('From labels and databases: {0}, estimated from USDA stand-ins: {1}, no data: {2}.', cov.labels, cov.estimated, cov.none)}
            {cov.left && ' ' + nt('Estimated values are not included in the amounts below.')}
            {cov.nothing && !cov.left && ' ' + nt('Foods from search often have micronutrient data; Quick add and AI estimates never do unless you fill them in.')}</>}
      </div>
      {cov && cov.estimated > 0 && <div className="row between nut-est-switch">
        <span>{nt('Include estimated values')}</span>
        <Switch checked={est} onChange={setEst} aria-label={nt('Include estimated values')} />
      </div>}
      {fillable.length > 0 && <div className="nut-fill-bar">
        <Button size="sm" icon="sparkles" onClick={() => openFillMicros({ date, entries: fillable, onDone: onChanged })}>{nt('Fill in missing ({0})', fillable.length)}</Button>
        <span className="muted small">{nt('Looks up USDA stand-ins for the entries with no vitamins or minerals. You review each one.')}</span>
      </div>}
      {groups.map(g => (g.rows.length > 0 || cov?.counted > 0) && <div key={g.id} className="nut-mgroup">
        <div className="nut-section-t">{nt(g.label)}</div>
        {g.rows.map(r => <div key={r.key} className="nut-mrow">
          <div className="row between nut-mrow-t"><span>{nt(r.label)}</span><span><b>{r.estimated && <span className="nut-est-mark" title={nt('Includes estimated values')} aria-label={nt('Includes estimated values')}>≈ </span>}{amountText(r.key, r.value, locale)}</b>{r.pct != null && <span className="muted"> · {r.pct}%</span>}</span></div>
          {r.pct != null && <MicroBar pct={r.pct} />}
        </div>)}
        {g.unknown.length > 0 && g.rows.length > 0 && <div className="dim small nut-munk">{nt('No data: {0}', g.unknown.map(x => nt(x)).join(', '))}</div>}
      </div>)}
      {p.marked.length > 0 && <div className="dim small nut-mnote">{nt('≈ includes amounts estimated from USDA stand-ins, not read from a label.')}</div>}
      <div className="dim small nut-mnote">{nt('Percent of the FDA Daily Value for adults is a general reference printed on food labels, not your personal need and not medical advice.')}</div>
    </div>}
  </div>
}
