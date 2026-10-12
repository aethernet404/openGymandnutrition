import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, Row, Section, Switch } from '../components/ui.jsx'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { goalsBody, kcalFromMacros } from './diary.js'
import { MacroFields } from './sheets.jsx'
import './nutrition.css'

const toast = m => useUI.getState().toast(m)

function Admin() {
  const [cfg, setCfg] = useState(null)
  const [cap, setCap] = useState(null)
  useEffect(() => { nutri.getAdmin().then(c => { setCfg(c); setCap(c.aiDailyCap) }).catch(() => {}) }, [])
  if (!cfg) return null
  const save = async patch => {
    try { const c = await nutri.putAdmin(patch); setCfg(c); setCap(c.aiDailyCap); toast(nt('Saved')) } catch (e) { toast(e.message) }
  }
  return <Section title={nt('Admin')} footer={nt('The AI limit counts photo and text analyses per person per day (UTC). 0 turns AI logging off. It is separate from the Coach limit.')}>
    <Row icon="globe" iconTint="var(--blue)" title={nt('Nutrition on')}>
      <Switch checked={cfg.enabled} onChange={on => save({ enabled: on })} />
    </Row>
    <div className="lrow">
      <span className="lrow-m"><span className="lrow-t">{nt('AI analyses per day')}</span><span className="lrow-s">{nt('Default {0}, up to {1}', cfg.aiCapDefault, cfg.aiCapMax)}</span></span>
      <span className="nut-input nut-cap"><NumberField decimal={false} nullable={false} value={cap} onChange={setCap} aria-label={nt('AI analyses per day')} /></span>
      <Button size="sm" onClick={() => save({ aiDailyCap: Math.round(cap || 0) })} disabled={Math.round(cap || 0) === cfg.aiDailyCap}>{nt('Save')}</Button>
    </div>
  </Section>
}

export default function Goals() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const [g, setG] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    nutri.getGoals().then(r => setG({ calories: r.goals?.calories ?? null, protein_g: r.goals?.protein_g ?? null, carbs_g: r.goals?.carbs_g ?? null, fat_g: r.goals?.fat_g ?? null }))
      .catch(e => { toast(e.message); setG({ calories: null, protein_g: null, carbs_g: null, fat_g: null }) })
  }, [])

  const save = async () => {
    const r = goalsBody(g)
    if (!r.ok) { toast(nt(r.error)); return }
    setBusy(true)
    try { await nutri.putGoals(r.body); toast(nt('Goals saved')); nav('/nutrition') } catch (e) { toast(e.message); setBusy(false) }
  }

  const implied = g ? kcalFromMacros(g) : 0
  const gap = g?.calories ? implied - g.calories : 0

  return <div className="narrow nut">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/nutrition')} aria-label={nt('Nutrition')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 10 }}><h1>{nt('Daily goals')}</h1><div className="sub">{nt('Your own targets')}</div></div>
    </div>
    {g && <div className="card">
      <div className="muted small" style={{ marginBottom: 12 }}>{nt('Set what you are aiming for each day. Leave a field empty for no target.')}</div>
      <MacroFields v={g} set={setG} />
      {implied > 0 && <div className={'small nut-implied' + (g.calories && Math.abs(gap) > 0.1 * g.calories ? ' warn' : '')}>
        {nt('Your macros add up to about {0} kcal', implied)}
        {g.calories ? (Math.abs(gap) > 0.1 * g.calories ? ' — ' + nt('{0} kcal {1} your calorie goal', Math.abs(gap), gap > 0 ? nt('above') : nt('below')) : ' — ' + nt('in line with your calorie goal')) : ''}
      </div>}
      <div style={{ height: 14 }} />
      <Button variant="primary" onClick={save} disabled={busy}>{nt('Save goals')}</Button>
    </div>}
    {user?.admin && <Admin />}
  </div>
}
