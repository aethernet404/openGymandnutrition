// The Micronutrients card under the diary's macro summary: closed until tapped, then each known nutrient with its amount
// and its percent of the FDA Daily Value, grouped Vitamins / Minerals / Other, a coverage line that says how much of the
// day it is based on, a Food only / Food + supplements switch, and (neutral, always visible) a note for anything above the
// usual adult upper limit. Nutrients nobody knows are listed as unknown, never drawn as zero.
import { useState } from 'react'
import Icon from '../components/Icon.jsx'
import { Segmented } from '../components/ui.jsx'
import { dateLocale } from '../lib/i18n.js'
import { nt } from './i18n.js'
import { amountText, coverage, groupedRows, pick, upperLimitNotes } from './micros.js'

const MODE_KEY = 'nut_micros_mode'
const readMode = () => { try { return localStorage.getItem(MODE_KEY) === 'food' ? 'food' : 'all' } catch { return 'all' } }
const writeMode = m => { try { localStorage.setItem(MODE_KEY, m) } catch { /* a per-device convenience only */ } }

export function MicroBar({ pct }) {
  const over = pct > 100
  return <div className={'nut-mbar' + (over ? ' over' : '')} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={nt('{0}% of the Daily Value', pct)}>
    <i style={{ width: Math.min(100, pct) + '%' }} />
  </div>
}

export default function MicrosCard({ micros }) {
  const [open, setOpen] = useState(false)
  const [mode, setModeState] = useState(readMode)
  const setMode = m => { setModeState(m); writeMode(m) }
  if (!micros) return null
  const locale = dateLocale()
  const p = pick(micros, mode)
  const cov = coverage(p)
  const groups = groupedRows(p.totals)
  const notes = upperLimitNotes(micros, locale)          // from everything eaten and taken, whichever way the card is showing it

  return <div className="card nut-micros">
    <button type="button" className="nut-micros-h" onClick={() => setOpen(o => !o)} aria-expanded={open}>
      <span><b>{nt('Micronutrients')}</b>{cov && !open && <span className="muted small"> · {cov.none ? nt('no data yet') : nt('{0} of {1} entries', cov.withData, cov.entries)}</span>}</span>
      <Icon name={open ? 'chevronUp' : 'chevronDown'} />
    </button>

    {notes.length > 0 && <ul className="nut-ul-notes">
      {notes.map(n => <li key={n.key}>
        {nt('{0}: {1} today{2} is above the usual upper limit for adults ({3}{4}). Worth checking with a doctor or pharmacist.', nt(n.label), n.amount, n.scope === 'supplement' ? ' ' + nt('from supplements') : '', n.limit, n.note ? '; ' + nt(n.note) : '')}
      </li>)}
    </ul>}

    {open && <div className="nut-micros-b">
      <Segmented value={mode} onChange={setMode} options={[{ value: 'food', label: nt('Food only') }, { value: 'all', label: nt('Food + supplements') }]} />
      <div className="muted small nut-cov" role="status">
        {!cov ? nt('Nothing logged for this day yet.')
          : cov.none ? nt('None of the {0} entries have micronutrient data. Foods from search often do; Quick add and AI estimates never do unless you fill them in.', cov.entries)
            : cov.partial ? nt('Based on {0} of {1} entries that have micronutrient data.', cov.withData, cov.entries)
              : nt('Based on all {0} entries.', cov.entries)}
      </div>
      {groups.map(g => (g.rows.length > 0 || cov?.withData > 0) && <div key={g.id} className="nut-mgroup">
        <div className="nut-section-t">{nt(g.label)}</div>
        {g.rows.map(r => <div key={r.key} className="nut-mrow">
          <div className="row between nut-mrow-t"><span>{nt(r.label)}</span><span><b>{amountText(r.key, r.value, locale)}</b>{r.pct != null && <span className="muted"> · {r.pct}%</span>}</span></div>
          {r.pct != null && <MicroBar pct={r.pct} />}
        </div>)}
        {g.unknown.length > 0 && g.rows.length > 0 && <div className="dim small nut-munk">{nt('No data: {0}', g.unknown.map(x => nt(x)).join(', '))}</div>}
      </div>)}
      <div className="dim small nut-mnote">{nt('Percent of the FDA Daily Value for adults is a general reference printed on food labels, not your personal need and not medical advice.')}</div>
    </div>}
  </div>
}
