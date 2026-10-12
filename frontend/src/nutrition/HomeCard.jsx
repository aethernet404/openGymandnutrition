// The Nutrition card on Home: today's calories at a glance, one tap into the diary. Rendered only
// for a signed-in profile (guest mode never reaches the server), and it stays quiet if the
// server cannot be reached or an admin has switched Nutrition off — Home must never wait on it.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import { tappable } from '../lib/use-sheet-keyboard.js'
import { todayISO } from '../lib/format.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { Bar } from './Diary.jsx'

export default function NutritionHomeCard() {
  const nav = useNavigate()
  const [day, setDay] = useState(null)
  const [off, setOff] = useState(false)
  useEffect(() => {
    let live = true
    nutri.getDay(todayISO()).then(d => live && setDay(d)).catch(e => { if (live && e.data?.code === 'off') setOff(true) })
    return () => { live = false }
  }, [])
  if (off) return null
  const goal = day?.goals?.calories
  return <div className="card tappable" style={{ cursor: 'pointer' }} {...tappable(() => nav('/nutrition'))}>
    <div className="row between">
      <div className="row" style={{ gap: 9, minWidth: 0 }}>
        <span className="lrow-i" style={{ background: 'var(--green)' }}><Icon name="flame" /></span>
        <div style={{ minWidth: 0 }}>
          <div className="lbl2">{nt('Nutrition')}</div>
          <div className="ttl">{day ? (day.entries.length || goal
            ? <>{day.totals.calories.toLocaleString()}{goal ? <span className="muted"> / {goal.toLocaleString()}</span> : null} kcal</>
            : nt('Log your food')) : nt('Food & macros')}</div>
        </div>
      </div>
      <Icon name="chevronRight" className="chev" />
    </div>
    {day && goal > 0 && <Bar value={day.totals.calories} goal={goal} />}
  </div>
}
