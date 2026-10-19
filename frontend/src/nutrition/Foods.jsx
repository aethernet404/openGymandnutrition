import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Icon from '../components/Icon.jsx'
import { Button, SearchField, Segmented } from '../components/ui.jsx'
import { useUI } from '../store/useUI.js'
import { nt } from './i18n.js'
import * as nutri from './api.js'
import { macroLine } from './diary.js'
import { openFoodSheet } from './sheets.jsx'
import './nutrition.css'

export default function Foods() {
  const nav = useNavigate()
  const [kind, setKind] = useState('food')          // food | supplement: saved supplements are listed apart
  const [scope, setScope] = useState('all')
  const [text, setText] = useState('')
  const [foods, setFoods] = useState(null)
  const [error, setError] = useState('')
  const seq = useRef(0)

  const load = () => {
    const n = ++seq.current
    nutri.listFoods(scope, text, kind === 'supplement' ? 'supplement' : '')
      .then(r => { if (n === seq.current) { setFoods(r.foods); setError('') } })
      .catch(e => { if (n === seq.current) { setError(e.message); setFoods(f => f || []) } })
  }
  useEffect(() => { const id = setTimeout(load, text ? 200 : 0); return () => clearTimeout(id) }, [scope, text, kind])

  const star = async f => {
    try { await nutri.updateFood(f.id, { favorite: !f.favorite }); load() } catch (e) { useUI.getState().toast(e.message) }
  }

  return <div className="narrow nut">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/nutrition')} aria-label={nt('Nutrition')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 10 }}><h1>{kind === 'supplement' ? nt('My supplements') : nt('My foods')}</h1><div className="sub">{kind === 'supplement' ? nt('Vitamins and supplements you take') : nt('Foods you made or reuse')}</div></div>
      <Button size="sm" icon="plus" onClick={() => openFoodSheet({ onSaved: load, ...(kind === 'supplement' ? { prefill: { type: 'supplement' } } : {}) })}>{nt('New')}</Button>
    </div>
    <Segmented value={kind} onChange={setKind} options={[{ value: 'food', label: nt('Foods') }, { value: 'supplement', label: nt('Supplements') }]} />
    <div style={{ height: 8 }} />
    <Segmented value={scope} onChange={setScope} options={[{ value: 'all', label: nt('All') }, { value: 'favorite', label: nt('Favourites') }, { value: 'recent', label: nt('Recent') }]} />
    <div style={{ height: 10 }} />
    <SearchField value={text} onChange={e => setText(e.target.value)} onClear={() => setText('')} placeholder={nt('Search my foods')} />
    <div style={{ height: 12 }} />
    {error && <div className="small" style={{ color: 'var(--red)', marginBottom: 8 }}>{error}</div>}
    {foods === null ? <div className="muted small">{nt('Loading…')}</div> : foods.length === 0 ? <div className="card muted small">
      {scope === 'favorite' ? nt('Star a food to keep it here.') : text ? nt('No food matches that.') : nt('No foods yet. Create the ones you eat often and log them in two taps.')}
    </div> : <div className="sect-b nut-foods">
      {foods.map(f => <div key={f.id} className="lrow nut-food">
        <button className="lrow-m nut-food-m" onClick={() => openFoodSheet({ food: f, onSaved: load })}>
          <span className="lrow-t">{f.name}{f.origin === 'ai' && <span className="tag nut-src nut-ai-badge">{nt('AI estimate')}</span>}</span>
          <span className="lrow-s">{f.brand ? f.brand + ' · ' : ''}{f.serving.label} · {f.per.calories} kcal · {macroLine(f.per)}</span>
        </button>
        <button className={'iconbtn nut-star' + (f.favorite ? ' on' : '')} onClick={() => star(f)} aria-label={f.favorite ? nt('Remove from favourites') : nt('Add to favourites')} aria-pressed={f.favorite}>
          <Icon name={f.favorite ? 'starFill' : 'star'} />
        </button>
      </div>)}
    </div>}
  </div>
}
