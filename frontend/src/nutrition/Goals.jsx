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

// Admin only, off by default: keeps the SHAPE of the last Health Auto Export payload for an hour so a
// wrong guess about the app's format can be settled from what it really sends. Never any token.
function HealthDebug() {
  const [state, setState] = useState(null)       // { enabled, capture, ttlMinutes }
  const [busy, setBusy] = useState(false)
  const load = () => Promise.resolve(nutri.getHealthDebug()).then(r => r && setState(r)).catch(() => {})
  useEffect(() => { load() }, [])
  if (!state) return null
  const toggle = async on => {
    setBusy(true)
    try { await nutri.putAdmin({ healthDebug: on }); await load(); toast(on ? nt('Debug on: the next export is captured') : nt('Debug off; the capture was wiped')) } catch (e) { toast(e.message) }
    setBusy(false)
  }
  const shape = state.capture ? JSON.stringify({ received: new Date(state.capture.at).toISOString(), shape: state.capture.shape, parsedAs: state.capture.outcome }, null, 2) : ''
  return <Section title={nt('Health Auto Export debug')} footer={nt('Off by default. When on, the shape of the last export (key names and one example item per metric, never the token) is kept in memory for {0} minutes, then forgotten. Use it to see what the app really sends.', state.ttlMinutes)}>
    <Row icon="bug" iconTint="var(--orange)" title={nt('Keep the last payload’s shape')}>
      <Switch checked={state.enabled} onChange={toggle} disabled={busy} />
    </Row>
    {state.enabled && <div className="lrow nut-usda-row">
      <Button size="sm" onClick={load}>{nt('Refresh')}</Button>
      {state.capture && <Button size="sm" variant="ghost" style={{ color: 'var(--red)' }} onClick={async () => { await nutri.clearHealthDebug().catch(() => {}); load() }}>{nt('Clear')}</Button>}
    </div>}
    {state.enabled && !state.capture && <div className="lrow nut-usda-help"><span className="small muted">{nt('Nothing captured yet. Tap Manual Export in the app, then Refresh.')}</span></div>}
    {state.capture && <div className="lrow nut-usda-row"><pre className="nut-code block" style={{ maxHeight: 320, overflow: 'auto' }}>{shape}</pre></div>}
  </Section>
}

// The one setting that needs a visit to another website. Everything about getting the key is on
// this card, because the person who needs it is standing here with a search that says "USDA is off".
function UsdaKey() {
  const [cfg, setCfg] = useState(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  useEffect(() => { nutri.getAdmin().then(setCfg).catch(() => {}) }, [])
  if (!cfg) return null
  const save = async value => {
    setBusy(true); setResult(null)
    try { setCfg(await nutri.putAdmin({ usdaKey: value })); setKey(''); toast(value ? nt('USDA key saved') : nt('USDA key removed')) } catch (e) { toast(e.message) }
    setBusy(false)
  }
  const test = async () => {
    setBusy(true); setResult(null)
    try { setResult(await nutri.testUsda()) } catch (e) { setResult({ ok: false, error: e.message }) }
    setBusy(false)
  }
  return <Section title={nt('USDA food search')} footer={nt('Food search always includes Open Food Facts. A free USDA FoodData Central key adds the USDA database (generic and branded foods).')}>
    <div className="lrow nut-usda">
      <span className="lrow-m">
        <span className="lrow-t">{cfg.usdaKeySet ? nt('Key set ({0})', cfg.usdaKeyHint || '…') : nt('No key set')}</span>
        <span className="lrow-s">{cfg.usdaKeySet ? nt('USDA search is on.') : nt('USDA search is off; Open Food Facts only.')}</span>
      </span>
    </div>
    <div className="lrow nut-usda-row">
      <input className="field" type="password" autoComplete="off" spellCheck="false" placeholder={nt('Paste your USDA API key')} value={key} onChange={e => setKey(e.target.value)} aria-label={nt('USDA API key')} />
      <Button size="sm" onClick={() => save(key.trim())} disabled={busy || key.trim().length < 8}>{nt('Save')}</Button>
    </div>
    {cfg.usdaKeySet && <div className="lrow nut-usda-row">
      <Button size="sm" onClick={test} disabled={busy}>{nt('Test key')}</Button>
      <Button size="sm" variant="ghost" style={{ color: 'var(--red)' }} onClick={() => save('')} disabled={busy}>{nt('Remove key')}</Button>
      {result && <span className="small" style={{ color: result.ok ? 'var(--green)' : 'var(--red)' }}>{result.ok ? nt('Works ({0} ms)', result.ms) : nt(result.error || 'Did not work')}</span>}
    </div>}
    <div className="lrow nut-usda-help"><span className="small muted">
      {nt('Get a free key: open')} <a href="https://fdc.nal.usda.gov/api-key-signup" target="_blank" rel="noopener noreferrer">fdc.nal.usda.gov/api-key-signup</a>, {nt('enter your name and email, and the key is emailed to you within a minute. Paste it above. The free limit is 1,000 searches an hour.')}
    </span></div>
  </Section>
}

// Opt-in, off by default. The footer says exactly what leaves, because that is the whole consent.
function CoachShare() {
  const [coach, setCoach] = useState(null)
  useEffect(() => { nutri.getConfig().then(c => setCoach(c.coach)).catch(() => {}) }, [])
  if (!coach?.available) return null
  const toggle = async on => {
    try { await nutri.setCoachShare(on); setCoach(c => ({ ...c, share: on })); toast(on ? nt('The Coach can now see your food summary') : nt('The Coach no longer sees your food')) } catch (e) { toast(e.message) }
  }
  return <Section title={nt('AI Coach')} footer={nt('When on, each Coach request includes your calories and macros for the last two weeks (a number per logged day), their average, and the goals above. No food names, brands, notes or photos. The Coach can read this and can never change your food log. Turn it off any time.')}>
    <Row icon="sparkles" iconTint="var(--green)" title={nt('Share a food summary with the Coach')}>
      <Switch checked={!!coach.share} onChange={toggle} />
    </Row>
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
    {g && <Section><Row icon="heart" iconTint="var(--red)" title={nt('Apple Health')} subtitle={nt('Calories, workouts and weight, from Health Auto Export or a Shortcut')} accessory="chevron" onClick={() => nav('/nutrition/health')} /></Section>}
    {g && <CoachShare />}
    {user?.admin && <Admin />}
    {user?.admin && <UsdaKey />}
    {user?.admin && <HealthDebug />}
  </div>
}
