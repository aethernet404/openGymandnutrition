// The Apple Health card on Home, under the Nutrition card: today's calories burned, steps, exercise minutes,
// latest weight and when it last updated. Before anything is set up it is a short prompt that opens the setup
// screen instead of a row of zeros. Like the Nutrition card it only exists for a signed-in profile, and it
// stays quiet (renders nothing) while loading, if an admin has switched Nutrition off, or on any server error.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { todayISO } from '../lib/format.js'
import { dateLocale } from '../lib/i18n.js'
import { useStore } from '../store/useStore.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { updatedText, weightText } from './diary.js'
import { cardState } from './health-stats.js'

export default function HealthHomeCard() {
  const nav = useNavigate()
  const unit = useStore(s => s.S?.unit) === 'lb' ? 'lb' : 'kg'
  const [h, setH] = useState(null)
  useEffect(() => {
    let live = true
    Promise.resolve(nutri.getHealthHistory(todayISO(), 1)).then(r => live && setH(r)).catch(() => {})
    return () => { live = false }
  }, [])
  const c = cardState(h)
  if (c.kind === 'none') return null
  const go = to => ({ ...tappable(() => nav(to)) })
  const shell = (to, title, body, extra) => <div className="card tappable nut-hcard" style={{ cursor: 'pointer' }} {...go(to)}>
    <div className="row between">
      <div className="row" style={{ gap: 9, minWidth: 0 }}>
        <span className="lrow-i" style={{ background: 'var(--red)' }}><Icon name="heart" /></span>
        <div style={{ minWidth: 0 }}>
          <div className="lbl2">{nt('Apple Health')}</div>
          <div className="ttl">{title}</div>
        </div>
      </div>
      <Icon name="chevronRight" className="chev" />
    </div>
    {body}{extra}
  </div>

  if (c.kind === 'setup') return shell('/nutrition/health', nt('Set up Apple Health'), <div className="muted small nut-hcard-sub">{nt('See calories burned, steps, workouts and weight from your iPhone.')}</div>)

  const bits = []
  if (c.steps != null) bits.push(nt('{0} steps', c.steps.toLocaleString(dateLocale())))
  if (c.exercise_min != null) bits.push(nt('{0} exercise min', c.exercise_min.toLocaleString(dateLocale())))
  if (c.weightKg != null) bits.push(weightText(c.weightKg, unit))
  const title = c.kind === 'waiting' ? nt('Waiting for the first sync')
    : c.burned != null ? <>{c.burned.toLocaleString(dateLocale())} kcal <span className="muted small">{nt('burned today')}</span></>
      : nt('No numbers for today yet')
  return shell('/nutrition/apple-health', title,
    bits.length > 0 ? <div className="muted small nut-hcard-sub">{bits.join(' · ')}</div> : null,
    c.updatedAt ? <div className="dim small nut-hcard-sub">{nt('Updated {0}', updatedText(c.updatedAt, Date.now(), dateLocale()))}</div> : null)
}
