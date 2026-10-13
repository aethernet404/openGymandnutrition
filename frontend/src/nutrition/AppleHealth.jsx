// Apple Health stats: today in detail, the last 7 or 30 days of calories burned and steps, the weight trend,
// and recent workouts, from what Health Auto Export (or the Shortcut) has sent. Reading only: the numbers are
// whatever arrived, a figure that never arrived is a dash rather than a zero, and workout calories are shown
// for reading only (they are already inside Active Energy). Setup lives on /nutrition/health.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import { Button, Section, Segmented } from '../components/ui.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { todayISO } from '../lib/format.js'
import { dateLocale } from '../lib/i18n.js'
import { useStore } from '../store/useStore.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { sparkPath, updatedText, weightText, weightTrend, workoutLine } from './diary.js'
import { barPct, hasWorkouts, rangeSeries } from './health-stats.js'
import './nutrition.css'

const nf = n => Math.round(n).toLocaleString(dateLocale())
const dash = '–'
const shortDay = iso => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 12).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
const longDay = iso => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), 12).toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short' })

function Tile({ label, value, unit }) {
  return <div className="nut-tile">
    <span className="muted small">{label}</span>
    <b>{value == null ? dash : nf(value)}{value != null && unit ? <span className="muted small"> {unit}</span> : null}</b>
  </div>
}

/** Bars for one figure over a range. Tap a bar to read its day; days without data are gaps, not zero-height bars. */
export function BarChart({ series, unit, label, color }) {
  const [sel, setSel] = useState(null)
  const { points, max, avg, have } = series
  if (!have) return <div className="dim small nut-none">{nt('No data in this range yet.')}</div>
  const picked = points.find(p => p.date === sel)
  return <div className="nut-chart">
    <div className="row between small muted"><span>{nt('Average {0} {1} (days with data)', nf(avg), unit)}</span><span>{nt('Highest {0}', nf(max))}</span></div>
    <div className="nut-bars" role="img" aria-label={label}>
      {points.map(p => <button key={p.date} className={'nut-bar-col' + (p.v == null ? ' gap' : '') + (p.date === sel ? ' on' : '')} onClick={() => setSel(p.date === sel ? null : p.date)}
        aria-label={p.v == null ? nt('{0}: no data', longDay(p.date)) : `${longDay(p.date)}: ${nf(p.v)} ${unit}`}>
        <i style={{ height: barPct(p.v, max) + '%', background: color }} />
      </button>)}
    </div>
    <div className="row between small dim"><span>{shortDay(points[0].date)}</span><span>{shortDay(points.at(-1).date)}</span></div>
    <div className="small nut-chart-read" aria-live="polite">{picked ? (picked.v == null ? nt('{0}: no data', longDay(picked.date)) : `${longDay(picked.date)} · ${nf(picked.v)} ${unit}`) : nt('Tap a bar to see its day.')}</div>
  </div>
}

export default function AppleHealth() {
  const nav = useNavigate()
  const unit = useStore(s => s.S?.unit) === 'lb' ? 'lb' : 'kg'
  const [h, setH] = useState(null)
  const [error, setError] = useState('')
  const [range, setRange] = useState(7)
  const today = todayISO()

  const load = () => Promise.resolve(nutri.getHealthHistory(today, 30)).then(r => { setH(r); setError('') }).catch(e => setError(e?.message || nt('Something went wrong')))
  useEffect(() => { load() }, [])

  const t = h?.days?.at(-1)
  const todays = t?.workouts || []
  const burned = rangeSeries(h?.days, 'burned_kcal', range)
  const steps = rangeSeries(h?.days, 'steps', range)
  const wt = weightTrend(h?.weight?.readings, unit)
  const wpath = sparkPath(wt.points.map(p => p.v))
  const setup = <Button size="sm" icon="heart" onClick={() => nav('/nutrition/health')}>{nt('Token, address & guide')}</Button>

  return <div className="narrow nut">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/nutrition')} aria-label={nt('Nutrition')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 10, minWidth: 0 }}><h1>{nt('Apple Health')}</h1><div className="sub">{nt('From Health Auto Export')}</div></div>
    </div>
    {error && !h && <div className="card">
      <div style={{ color: 'var(--red)', marginBottom: 6 }}>{nt('Could not load Apple Health.')}</div>
      <div className="muted small" style={{ marginBottom: 10 }}>{error}</div>
      <Button size="sm" onClick={load}>{nt('Try again')}</Button>
    </div>}
    {!h && !error && <div className="card"><div className="muted small">{nt('Loading…')}</div></div>}

    {h && <>
      <div className="card nut-ah-sync">
        <div className="row between" style={{ gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div className="lbl2">{nt('Last sync')}</div>
            <div className="ttl">{h.updatedAt ? updatedText(h.updatedAt, Date.now(), dateLocale()) : nt('Nothing received yet')}</div>
          </div>
          {setup}
        </div>
        {!h.hasData && <div className="muted small" style={{ marginTop: 8 }}>{h.token ? nt('Your token is ready. The numbers appear after the first export from Health Auto Export.') : nt('Set up Apple Health first: make a token and point Health Auto Export at this server.')}</div>}
      </div>

      {h.hasData && <>
        <Section title={nt('Today')}>
          <div className="nut-tiles">
            <Tile label={nt('Burned')} value={t.burned_kcal} unit="kcal" />
            <Tile label={nt('Active')} value={t.active_kcal} unit="kcal" />
            <Tile label={nt('Resting')} value={t.resting_kcal} unit="kcal" />
            <Tile label={nt('Steps')} value={t.steps} />
            <Tile label={nt('Exercise')} value={t.exercise_min} unit="min" />
          </div>
          {t.burned_kcal == null && <div className="dim small nut-none">{nt('No energy numbers for today yet.')}</div>}
          {todays.length > 0 && <ul className="nut-workouts">{todays.map((w, i) => <li key={i}><span className="muted small">{w.time}</span> {workoutLine(w, unit)}</li>)}</ul>}
          {todays.length === 0 && t.burned_kcal != null && <div className="dim small nut-none">{nt('No workouts today.')}</div>}
        </Section>

        <div className="nut-rangebar"><Segmented options={[{ value: 7, label: nt('7 days') }, { value: 30, label: nt('30 days') }]} value={range} onChange={setRange} /></div>
        <div className="card">
          <h2 style={{ margin: '0 0 8px' }}>{nt('Calories burned')}</h2>
          <BarChart series={burned} unit="kcal" label={nt('Calories burned per day')} color="var(--orange)" />
        </div>
        <div className="card">
          <h2 style={{ margin: '0 0 8px' }}>{nt('Steps')}</h2>
          <BarChart series={steps} unit={nt('steps')} label={nt('Steps per day')} color="var(--green)" />
        </div>
      </>}

      <div className="card nut-weight">
        <h2 style={{ margin: '0 0 8px' }}>{nt('Weight')}</h2>
        {h.weight?.latest ? <>
          <div className="row between" style={{ gap: 12 }}>
            <b className="nut-weight-v">{weightText(h.weight.latest.kg, unit)}</b>
            {wpath ? <div className="center"><svg viewBox="0 0 120 32" width="120" height="32" role="img" aria-label={nt('Weight, last 30 days')}><path d={wpath} fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              {wt.change != null && <div className="muted small">{nt('{0} in 30 days', (wt.change > 0 ? '+' : wt.change < 0 ? '−' : '') + Math.abs(wt.change) + ' ' + unit)}</div>}</div>
              : <span className="dim small">{nt('A line appears with two readings')}</span>}
          </div>
          <div className="dim small nut-energy-sub">{nt('Latest reading {0}', shortDay(h.weight.latest.date))}</div>
        </> : <div className="dim small nut-none">{nt('No weight yet. Turn on Weight in the Health Auto Export automation.')}</div>}
      </div>

      {hasWorkouts(h) && <div className="card">
        <h2 style={{ margin: '0 0 6px' }}>{nt('Recent workouts')}</h2>
        <ul className="nut-workouts">{h.workouts.map((w, i) => <li key={i}><span className="muted small">{shortDay(w.date)} {w.time}</span><br />{workoutLine(w, unit)}</li>)}</ul>
        <div className="dim small nut-energy-sub">{nt('Workout calories are already inside Active; they are not added again.')}</div>
      </div>}
      {h.hasData && !hasWorkouts(h) && <div className="card"><h2 style={{ margin: '0 0 6px' }}>{nt('Recent workouts')}</h2><div className="dim small nut-none">{nt('No workouts in the last 30 days. Turn on Workouts in the automation to see them here.')}</div></div>}
    </>}
  </div>
}
