import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { todayISO } from '../lib/format.js'
import { dateLocale } from '../lib/i18n.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { openAddSheet, openEditEntry, openSaveFood } from './sheets.jsx'
import MicrosCard from './MicrosCard.jsx'
import { openSupplementSheet } from './Supplements.jsx'
import { useStore } from '../store/useStore.js'
import { EMPTY_TOTALS, MACRO_KEYS, foodFromEntry, MACRO_LABEL, MEALS, MEAL_LABEL, burnedOf, fraction, goalWithEatBack, macroLine, mealForHour, netOf, relativeDay, remaining, shiftISO, signed, sparkPath, trim, updatedText, validISO, weightText, weightTrend, workoutLine } from './diary.js'
import './nutrition.css'

const nf = n => Math.round(n || 0).toLocaleString(dateLocale())

export function Bar({ value, goal, className = '' }) {
  const f = fraction(value, goal)
  return <div className={'nut-bar ' + className + (f != null && f > 1.05 ? ' over' : '')} role="progressbar" aria-valuenow={Math.round(value || 0)} aria-valuemax={goal || undefined}>
    <i style={{ width: Math.min(100, (f ?? 0) * 100) + '%' }} />
  </div>
}

function dayLabel(date, today) {
  const rel = relativeDay(date, today)
  if (rel === 'today') return nt('Today')
  if (rel === 'yesterday') return nt('Yesterday')
  if (rel === 'tomorrow') return nt('Tomorrow')
  const d = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 12)
  return d.toLocaleDateString(dateLocale(), { weekday: 'short', day: 'numeric', month: 'short', ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) })
}

function Summary({ totals, goals, health, eatBack, onGoals, onHealth }) {
  const g = goals || {}
  // The calorie goal for THIS day: as set, plus a share of the day's active calories when "eat back" is on.
  const adj = goalWithEatBack(g.calories, health, eatBack)
  const left = remaining(totals.calories, adj.goal)
  const burned = burnedOf(health)
  const net = netOf(totals.calories, health)
  return <div className="card nut-summary">
    <div className="row between" style={{ alignItems: 'flex-end' }}>
      <div>
        <div className="muted small">{nt('Calories')}</div>
        <div className="big">{nf(totals.calories)}{adj.goal ? <span className="muted nut-of"> / {nf(adj.goal)}</span> : <span className="muted nut-of"> kcal</span>}</div>
      </div>
      {adj.goal ? <div className={'nut-left' + (left < 0 ? ' over' : '')}><b>{nf(Math.abs(left))}</b><span>{left < 0 ? nt('over') : nt('left')}</span></div>
        : <Button size="sm" icon="target" onClick={onGoals}>{nt('Set goals')}</Button>}
    </div>
    {adj.goal > 0 && <Bar value={totals.calories} goal={adj.goal} />}
    {adj.applied && <div className="muted small nut-eat">{nt('Goal {0} + {1} ({2}% of active calories)', nf(g.calories), nf(adj.extra), eatBack.percent)}</div>}
    {eatBack?.enabled && !health && g.calories > 0 && <div className="muted small nut-eat">{nt('Eat back is on; waiting for Apple Health numbers for this day. Using your normal goal.')}</div>}

    {health ? <div className="nut-energy">
      <div className="nut-energy-grid">
        <div><span className="muted small">{nt('Eaten')}</span><b>{nf(totals.calories)}</b></div>
        <div><span className="muted small">{nt('Burned')}</span><b>{nf(burned)}</b></div>
        <div><span className="muted small">{nt('Net')}</span><b>{signed(net)}</b></div>
      </div>
      <div className="muted small nut-energy-sub">
        {nt('Active {0} + resting {1}', nf(health.active_kcal), nf(health.resting_kcal))}{health.steps != null ? ' · ' + nt('{0} steps', nf(health.steps)) : ''} · {nt('Net is eaten − burned.')} {nt('Updated {0}', updatedText(health.updatedAt, Date.now(), dateLocale()))}
      </div>
    </div> : <button className="nut-energy-hint" onClick={onHealth}>
      <Icon name="heart" /><span>{nt('No Apple Health numbers for this day. Set it up')}</span><Icon name="chevronRight" />
    </button>}

    <div className="nut-macros">
      {MACRO_KEYS.map(k => <div key={k} className="nut-macro">
        <div className="row between small"><span className="muted">{nt(MACRO_LABEL[k])}</span><span><b>{trim(totals[k])}</b>{g[k] ? <span className="muted"> / {trim(g[k])} g</span> : <span className="muted"> g</span>}</span></div>
        {g[k] > 0 ? <Bar value={totals[k]} goal={g[k]} className={'m-' + k} /> : <div className="nut-bar empty" />}
      </div>)}
    </div>
  </div>
}

// Workouts and exercise minutes from Health Auto Export. For reading only: the calories here are already part
// of Active Energy above, so they are not added to Burned or Net.
function ActivityCard({ activity, unit }) {
  if (!activity) return null
  const ws = activity.workouts || []
  return <div className="card nut-activity">
    <div className="row between nut-meal-h">
      <div><h2>{nt('Workouts')}</h2>{activity.exercise_min != null && <span className="muted small">{nt('{0} exercise min', nf(activity.exercise_min))}</span>}</div>
    </div>
    {ws.length ? <ul className="nut-workouts">{ws.map((w, i) => <li key={i}><span className="muted small">{w.time}</span> {workoutLine(w, unit)}</li>)}</ul> : <div className="dim small nut-none">{nt('No workouts this day')}</div>}
    {ws.some(w => w.kcal != null) && <div className="dim small nut-energy-sub">{nt('Workout calories are already inside Active; they are not added again.')}</div>}
  </div>
}

// Latest weight with a 30-day line, from Health Auto Export. Optional: with no data it says how to get it.
function WeightCard({ weight, unit, onSetup }) {
  if (!weight) return null
  if (!weight.latest) return <button className="nut-energy-hint" onClick={onSetup}><Icon name="heart" /><span>{nt('No weight from Apple Health yet. Turn on Weight in the Health Auto Export automation')}</span><Icon name="chevronRight" /></button>
  const { points, change } = weightTrend(weight.readings, unit)
  const path = sparkPath(points.map(p => p.v))
  return <div className="card nut-weight">
    <div className="row between">
      <div><div className="muted small">{nt('Weight')}</div><b className="nut-weight-v">{weightText(weight.latest.kg, unit)}</b></div>
      {path ? <div className="nut-center"><svg viewBox="0 0 120 32" width="120" height="32" role="img" aria-label={nt('Weight, last 30 days')}><path d={path} fill="none" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {change != null && <div className="muted small">{nt('{0} in 30 days', (change > 0 ? '+' : change < 0 ? '−' : '') + Math.abs(change) + ' ' + unit)}</div>}</div>
        : <span className="dim small">{nt('A line appears with two readings')}</span>}
    </div>
    <div className="dim small nut-energy-sub">{nt('Latest reading {0}', weight.latest.date)}</div>
  </div>
}

function MealCard({ meal, entries, totals, onAdd, onEdit }) {
  const supplements = meal === 'supplements'
  return <div className="card nut-meal">
    <div className="row between nut-meal-h">
      <div><h2>{nt(MEAL_LABEL[meal])}</h2>{entries.length > 0 && (!supplements || totals.calories > 0) && <span className="muted small">{nf(totals.calories)} kcal</span>}</div>
      <Button size="sm" icon="plus" onClick={onAdd} aria-label={nt('Add to {0}', nt(MEAL_LABEL[meal]).toLowerCase())}>{nt('Add')}</Button>
    </div>
    {entries.length === 0 ? <div className="dim small nut-none">{nt('Nothing logged')}</div> : <div className="nut-entries">
      {entries.map(e => <div key={e.id} className="nut-entry tap" {...tappable(() => onEdit(e))}>
        <div className="nut-entry-m">
          <div className="nut-entry-t">{e.name}{e.source === 'ai' && <Icon name="sparkles" className="nut-ai" aria-label={nt('Estimated by AI')} />}</div>
          <div className="nut-entry-s">{supplements
            ? [e.serving ? `${trim(e.qty)} × ${e.serving}` : trim(e.qty) + ' ×', e.micros && Object.keys(e.micros).length ? nt('{0} nutrients', Object.keys(e.micros).length) : null].filter(Boolean).join(' · ')
            : <>{e.source === 'food' && e.serving ? `${trim(e.qty)} × ${e.serving} · ` : ''}{macroLine(e)}</>}</div>
        </div>
        {(!supplements || e.calories > 0) && <div className="nut-kcal">{nf(e.calories)}</div>}
      </div>)}
    </div>}
  </div>
}

export default function Diary() {
  const nav = useNavigate()
  const [sp, setSp] = useSearchParams()
  const today = todayISO()
  const date = validISO(sp.get('d')) ? sp.get('d') : today
  const setDate = d => setSp(d === today ? {} : { d }, { replace: true })

  const [state, setState] = useState({ status: 'loading', day: null, error: '' })
  const seq = useRef(0)
  const load = useCallback(() => {
    const n = ++seq.current
    nutri.getDay(date)
      .then(day => { if (n === seq.current) setState({ status: 'ready', day, error: '' }) })
      .catch(e => { if (n === seq.current) setState(s => ({ status: e.data?.code === 'off' ? 'off' : 'error', day: s.day?.date === date ? s.day : null, error: e.message })) })
  }, [date])
  useEffect(() => { setState(s => (s.day?.date === date ? s : { ...s, status: 'loading', day: null })); load() }, [load])

  const unit = useStore(s => s.S?.unit) === 'lb' ? 'lb' : 'kg'
  const [weight, setWeight] = useState(null)
  useEffect(() => {
    let live = true
    Promise.resolve(nutri.getWeight(today)).then(w => { if (live) setWeight(w && typeof w === 'object' ? w : null) }).catch(() => { if (live) setWeight(null) })
    return () => { live = false }
  }, [today])

  // "Save this as a food for next time?" for AI entries just saved; in memory only, gone when dismissed or saved.
  const [prompts, setPrompts] = useState([])
  const afterAdd = made => { load(); if (Array.isArray(made) && made.length) setPrompts(p => [...p, ...made.filter(e => e && e.source === 'ai')].slice(-5)) }
  const dismiss = id => setPrompts(p => p.filter(e => e.id !== id))

  const { day, status } = state
  const byMeal = m => (day?.entries || []).filter(e => e.meal === m)
  const defaultMeal = mealForHour(new Date().getHours())

  return <div className="narrow nut">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={nt('Home')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 10 }}><h1>{nt('Nutrition')}</h1><div className="sub">{nt('Food & macros')}</div></div>
      <div className="hdr-actions">
        <button className="iconbtn" onClick={() => nav('/nutrition/foods')} aria-label={nt('My foods')}><Icon name="list" /></button>
        <button className="iconbtn" onClick={() => nav('/nutrition/goals')} aria-label={nt('Goals')}><Icon name="target" /></button>
      </div>
    </div>

    <div className="nut-datebar">
      <button className="iconbtn" onClick={() => setDate(shiftISO(date, -1))} aria-label={nt('Previous day')}><Icon name="chevronLeft" /></button>
      <label className="nut-datepick">
        <span>{dayLabel(date, today)}</span>
        <input type="date" value={date} onChange={e => validISO(e.target.value) && setDate(e.target.value)} aria-label={nt('Choose a date')} />
      </label>
      <button className="iconbtn" onClick={() => setDate(shiftISO(date, 1))} aria-label={nt('Next day')}><Icon name="chevronRight" /></button>
      {date !== today && <Button size="sm" variant="tinted" onClick={() => setDate(today)}>{nt('Today')}</Button>}
    </div>

    {status === 'off' && <div className="card"><div className="muted">{nt('Nutrition is switched off on this server. An admin can turn it on.')}</div></div>}
    {status === 'error' && !day && <div className="card">
      <div style={{ color: 'var(--red)', marginBottom: 6 }}>{nt('Could not load this day.')}</div>
      <div className="muted small" style={{ marginBottom: 10 }}>{state.error}</div>
      <Button size="sm" onClick={load}>{nt('Try again')}</Button>
    </div>}
    {status === 'loading' && !day && <div className="card"><div className="muted small">{nt('Loading…')}</div></div>}

    {day && status !== 'off' && <>
      <Summary totals={day.totals || EMPTY_TOTALS} goals={day.goals} health={day.health} eatBack={day.eatBack} onGoals={() => nav('/nutrition/goals')} onHealth={() => nav('/nutrition/health')} />
      <MicrosCard micros={day.micros} />
      <ActivityCard activity={day.activity} unit={unit} />
      <WeightCard weight={weight} unit={unit} onSetup={() => nav('/nutrition/health')} />
      {status === 'error' && <div className="small" style={{ color: 'var(--red)', margin: '0 4px 10px' }}>{nt('Could not refresh: {0}', state.error)} <button className="linkbtn" onClick={load}>{nt('Try again')}</button></div>}
      {prompts.filter(p => (day.entries || []).some(e => e.id === p.id)).map(p => <div key={p.id} className="nut-banner info nut-saveprompt">
        <Icon name="sparkles" />
        <span>{nt('Save “{0}” as a food for next time?', p.name)}</span>
        <button className="linkbtn" onClick={() => openSaveFood({ initial: foodFromEntry(p), onSaved: () => dismiss(p.id) })}>{nt('Save as food')}</button>
        <button className="iconbtn" onClick={() => dismiss(p.id)} aria-label={nt('Dismiss')}><Icon name="xmark" /></button>
      </div>)}
      {MEALS.map(m => <MealCard key={m} meal={m} entries={byMeal(m)} totals={day.byMeal?.[m] || EMPTY_TOTALS}
        onAdd={() => openAddSheet({ date, meal: m, onSaved: afterAdd })}
        onEdit={e => openEditEntry({ entry: e, date, onSaved: load })} />)}
      <MealCard meal="supplements" entries={byMeal('supplements')} totals={day.byMeal?.supplements || EMPTY_TOTALS}
        onAdd={() => openSupplementSheet({ date, onSaved: load })}
        onEdit={e => openEditEntry({ entry: e, date, onSaved: load })} />
      {!day.entries.length && <div className="nut-center muted small" style={{ margin: '6px 0 14px' }}>
        <Button variant="primary" icon="plus" onClick={() => openAddSheet({ date, meal: defaultMeal, onSaved: afterAdd })}>{nt('Log your first food')}</Button>
      </div>}
    </>}
  </div>
}
