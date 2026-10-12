import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { todayISO } from '../lib/format.js'
import { dateLocale } from '../lib/i18n.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { openAddSheet, openEditEntry } from './sheets.jsx'
import { EMPTY_TOTALS, MACRO_KEYS, MACRO_LABEL, MEALS, MEAL_LABEL, fraction, macroLine, mealForHour, relativeDay, remaining, shiftISO, trim, validISO } from './diary.js'
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

function Summary({ totals, goals, onGoals }) {
  const g = goals || {}
  const left = remaining(totals.calories, g.calories)
  return <div className="card nut-summary">
    <div className="row between" style={{ alignItems: 'flex-end' }}>
      <div>
        <div className="muted small">{nt('Calories')}</div>
        <div className="big">{nf(totals.calories)}{g.calories ? <span className="muted nut-of"> / {nf(g.calories)}</span> : <span className="muted nut-of"> kcal</span>}</div>
      </div>
      {g.calories ? <div className={'nut-left' + (left < 0 ? ' over' : '')}><b>{nf(Math.abs(left))}</b><span>{left < 0 ? nt('over') : nt('left')}</span></div>
        : <Button size="sm" icon="target" onClick={onGoals}>{nt('Set goals')}</Button>}
    </div>
    {g.calories > 0 && <Bar value={totals.calories} goal={g.calories} />}
    <div className="nut-macros">
      {MACRO_KEYS.map(k => <div key={k} className="nut-macro">
        <div className="row between small"><span className="muted">{nt(MACRO_LABEL[k])}</span><span><b>{trim(totals[k])}</b>{g[k] ? <span className="muted"> / {trim(g[k])} g</span> : <span className="muted"> g</span>}</span></div>
        {g[k] > 0 ? <Bar value={totals[k]} goal={g[k]} className={'m-' + k} /> : <div className="nut-bar empty" />}
      </div>)}
    </div>
  </div>
}

function MealCard({ meal, entries, totals, onAdd, onEdit }) {
  return <div className="card nut-meal">
    <div className="row between nut-meal-h">
      <div><h2>{nt(MEAL_LABEL[meal])}</h2>{entries.length > 0 && <span className="muted small">{nf(totals.calories)} kcal</span>}</div>
      <Button size="sm" icon="plus" onClick={onAdd} aria-label={nt('Add to {0}', nt(MEAL_LABEL[meal]).toLowerCase())}>{nt('Add')}</Button>
    </div>
    {entries.length === 0 ? <div className="dim small nut-none">{nt('Nothing logged')}</div> : <div className="nut-entries">
      {entries.map(e => <div key={e.id} className="nut-entry tap" {...tappable(() => onEdit(e))}>
        <div className="nut-entry-m">
          <div className="nut-entry-t">{e.name}{e.source === 'ai' && <Icon name="sparkles" className="nut-ai" aria-label={nt('Estimated by AI')} />}</div>
          <div className="nut-entry-s">{e.source === 'food' && e.serving ? `${trim(e.qty)} × ${e.serving} · ` : ''}{macroLine(e)}</div>
        </div>
        <div className="nut-kcal">{nf(e.calories)}</div>
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
      <Summary totals={day.totals || EMPTY_TOTALS} goals={day.goals} onGoals={() => nav('/nutrition/goals')} />
      {status === 'error' && <div className="small" style={{ color: 'var(--red)', margin: '0 4px 10px' }}>{nt('Could not refresh: {0}', state.error)} <button className="linkbtn" onClick={load}>{nt('Try again')}</button></div>}
      {MEALS.map(m => <MealCard key={m} meal={m} entries={byMeal(m)} totals={day.byMeal?.[m] || EMPTY_TOTALS}
        onAdd={() => openAddSheet({ date, meal: m, onSaved: load })}
        onEdit={e => openEditEntry({ entry: e, date, onSaved: load })} />)}
      {!day.entries.length && <div className="center muted small" style={{ margin: '6px 0 14px' }}>
        <Button variant="primary" icon="plus" onClick={() => openAddSheet({ date, meal: defaultMeal, onSaved: load })}>{nt('Log your first food')}</Button>
      </div>}
    </>}
  </div>
}
