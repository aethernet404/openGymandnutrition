// Settings → Apple Health: the token a Shortcut uses to send the day's Health calories, the
// "eat back" option, and the steps for building the Shortcut. The token is shown exactly once, here,
// when it is made — the server keeps only a hash, so there is nothing to show again.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import { Button, Row, Section, Stepper, Switch } from '../components/ui.jsx'
import { confirmSheet } from '../sheets.jsx'
import { useUI } from '../store/useUI.js'
import { copyText } from '../lib/clipboard.js'
import { dateLocale } from '../lib/i18n.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { GUIDE_URL, HAE_GUIDE_URL, HAE_METRICS, HAE_PREMIUM, HAE_STEPS, RELIABILITY, STEPS, bearerHeader, endpointUrl, exampleJson, haeEndpointUrl } from './health-guide.js'
import { updatedText } from './diary.js'
import './nutrition.css'

const toast = m => useUI.getState().toast(m)

function TokenShown({ token, close }) {
  const copy = async (text, what) => { toast((await copyText(text)) ? nt('{0} copied', what) : nt('Could not copy — select it by hand')) }
  return <>
    <h3>{nt('Your Apple Health token')}</h3>
    <div className="nut-banner warn"><Icon name="warning" /><span>{nt('This is the only time it is shown. Copy it into the Shortcut now. If you lose it, make a new one — the old one stops working.')}</span></div>
    <textarea className="nut-token" readOnly rows={3} value={token} onFocus={e => e.target.select()} aria-label={nt('Apple Health token')} />
    <div style={{ height: 8 }} />
    <Button variant="primary" icon="copy" onClick={() => copy(bearerHeader(token), nt('Header value'))}>{nt('Copy header value (Bearer …)')}</Button>
    <div style={{ height: 8 }} />
    <Button icon="copy" onClick={() => copy(token, nt('Token'))}>{nt('Copy the token only')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>{nt('I have copied it')}</Button>
  </>
}

export default function Health() {
  const nav = useNavigate()
  const [token, setToken] = useState(null)         // { set, createdAt, lastUsedAt, hint }
  const [eat, setEat] = useState({ enabled: false, percent: 50 })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const url = endpointUrl()
  const haeUrl = haeEndpointUrl()

  const load = () => nutri.getConfig().then(c => { setToken(c.health); setEat(c.health.eatBack); setError('') }).catch(e => setError(e.message))
  useEffect(() => { load() }, [])

  const make = async () => {
    setBusy(true)
    try {
      const r = await nutri.createHealthToken()
      useUI.getState().openSheet(close => <TokenShown token={r.token} close={close} />, { locked: true })
      await load()
    } catch (e) { toast(e.message) }
    setBusy(false)
  }
  const rotate = () => confirmSheet({
    title: nt('Make a new token?'), message: nt('The current token stops working immediately. Your Shortcut needs the new one.'), confirmText: nt('Make a new token'), danger: true, onConfirm: make
  })
  const revoke = () => confirmSheet({
    title: nt('Revoke the token?'), message: nt('The Shortcut will stop being able to send numbers. Numbers already stored stay.'), confirmText: nt('Revoke'), danger: true,
    onConfirm: async () => { try { await nutri.revokeHealthToken(); toast(nt('Token revoked')); await load() } catch (e) { toast(e.message) } }
  })
  const saveEat = async next => {
    const before = eat
    setEat(next)
    try { setEat((await nutri.putHealthSettings(next)).eatBack) } catch (e) { setEat(before); toast(e.message) }
  }
  const copy = async (text, what) => { toast((await copyText(text)) ? nt('{0} copied', what) : nt('Could not copy — select it by hand')) }

  return <div className="narrow nut">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/nutrition/goals')} aria-label={nt('Goals')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 10 }}><h1>{nt('Apple Health')}</h1><div className="sub">{nt('Calories, workouts and weight')}</div></div>
    </div>
    {error && <div className="nut-banner warn"><Icon name="warning" /><span>{error}</span></div>}

    <Section title={nt('Token')} footer={nt('A web page cannot read Apple Health, so a Shortcut on your iPhone sends the numbers here. The token lets it do that and nothing else: it can write a day’s calories and steps, and cannot read anything.')}>
      <div className="lrow nut-usda">
        <span className="lrow-m">
          <span className="lrow-t">{token?.set ? nt('Token {0}', token.hint) : nt('No token yet')}</span>
          <span className="lrow-s">{!token ? nt('Loading…') : !token.set ? nt('Make one to connect a Shortcut.')
            : token.lastUsedAt ? nt('Last used {0}', updatedText(token.lastUsedAt, Date.now(), dateLocale()))
              : nt('Never used yet. Made {0}.', updatedText(token.createdAt, Date.now(), dateLocale()))}</span>
        </span>
      </div>
      <div className="lrow nut-usda-row">
        {token?.set
          ? <><Button size="sm" onClick={rotate} disabled={busy}>{nt('Make a new token')}</Button><Button size="sm" variant="ghost" style={{ color: 'var(--red)' }} onClick={revoke} disabled={busy}>{nt('Revoke')}</Button></>
          : <Button size="sm" variant="primary" icon="plus" onClick={make} disabled={busy || !token}>{nt('Make a token')}</Button>}
      </div>
    </Section>

    <Section title={nt('Eat back')} footer={nt('Off by default. When on, a percentage of the day’s active calories (not resting) is added to that day’s calorie goal, and the goal on the diary is labelled with what was added.')}>
      <Row icon="flame" iconTint="var(--orange)" title={nt('Adjust the calorie goal by active calories')}>
        <Switch checked={eat.enabled} onChange={on => saveEat({ ...eat, enabled: on })} />
      </Row>
      {eat.enabled && <div className="lrow">
        <span className="lrow-m"><span className="lrow-t">{nt('Share of active calories')}</span><span className="lrow-s">{nt('{0}% of today’s active calories is added to the goal', eat.percent)}</span></span>
        <Stepper value={eat.percent} step={5} min={0} max={100} decimal={false} onChange={p => saveEat({ ...eat, percent: Math.round(p) })} ariaLabel={nt('Percent of active calories')} />
      </div>}
    </Section>

    <Section title={nt('Set up Health Auto Export')} footer={nt(HAE_PREMIUM)}>
      <div className="lrow nut-usda-help"><span className="small muted">{nt('The app posts to this address (Automations → REST API):')}</span></div>
      <div className="lrow nut-usda-row"><code className="nut-code">{haeUrl}</code><Button size="sm" icon="copy" onClick={() => copy(haeUrl, nt('Address'))}>{nt('Copy')}</Button></div>
      <div className="lrow nut-usda-help"><span className="small muted">{nt('Metrics to turn on: {0}.', HAE_METRICS.join(', '))}</span></div>
      <ol className="nut-steps">{HAE_STEPS.map((s, i) => <li key={i}>{nt(s)}</li>)}</ol>
      <div className="lrow nut-usda-help"><span className="small">
        <a href={HAE_GUIDE_URL} target="_blank" rel="noopener noreferrer">{nt('Open the full Health Auto Export guide')}</a>
      </span></div>
    </Section>

    <Section title={nt('Or: set up the Shortcut')} footer={RELIABILITY}>
      <div className="lrow nut-usda-help"><span className="small muted">{nt('Post to this address:')}</span></div>
      <div className="lrow nut-usda-row"><code className="nut-code">{url}</code><Button size="sm" icon="copy" onClick={() => copy(url, nt('Address'))}>{nt('Copy')}</Button></div>
      <div className="lrow nut-usda-help"><span className="small muted">{nt('with this JSON body (numbers, not text):')}</span></div>
      <div className="lrow nut-usda-row"><pre className="nut-code block">{exampleJson()}</pre><Button size="sm" icon="copy" onClick={() => copy(exampleJson(), nt('Example'))}>{nt('Copy')}</Button></div>
      <ol className="nut-steps">{STEPS.map((s, i) => <li key={i}>{nt(s)}</li>)}</ol>
      <div className="lrow nut-usda-help"><span className="small">
        <a href={GUIDE_URL} target="_blank" rel="noopener noreferrer">{nt('Open the full step-by-step guide')}</a>
      </span></div>
    </Section>
  </div>
}
