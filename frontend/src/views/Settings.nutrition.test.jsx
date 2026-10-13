// @vitest-environment happy-dom
//
// The Nutrition row on the Settings root. It did nothing when tapped: the row lives in
// SettingsRoot, a separate component from Settings, and its handler called `nav` — a name that
// only exists in Settings. The click threw a ReferenceError inside React's event handler, which
// shows nothing on screen. The row now goes through the `open` prop like every other root row.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({ S: null, user: null, navs: [], errors: [] }))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({
    S: mocks.S, user: mocks.user, coachLocal: null, sync: null, config: null,
    update: vi.fn(), replaceState: vi.fn(), setUser: vi.fn(), pullState: vi.fn(), pushState: vi.fn(), setUnit: vi.fn(),
    resetEverything: vi.fn(), resetDemo: vi.fn(), importBackup: vi.fn(), importConflict: vi.fn()
  })
  const useStore = sel => (sel ? sel(snap()) : snap())
  useStore.getState = snap
  return { useStore, DEF: { reminder: { time: '17:30' } }, hasData: () => false }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: vi.fn(), openSheet: () => ({ close: vi.fn() }) })
  const useUI = sel => (sel ? sel(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => (...a) => mocks.navs.push(a) }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({ passkeys: [] })), webauthnOK: () => false, passkeyLogin: vi.fn(), passkeyRegister: vi.fn(), IS_ANDROID: false }))
vi.mock('../lib/push.js', () => ({ pushSupported: () => false, enablePush: vi.fn(), disablePush: vi.fn(), sendTestPush: vi.fn(), syncPushSubscription: vi.fn(() => Promise.resolve(false)) }))
vi.mock('../lib/wakelock.js', () => ({ wakeLockSupported: () => true }))
vi.mock('../lib/mobile.js', () => ({ MOBILE: false, isAndroid: () => Promise.resolve(false), shareExport: vi.fn(), shareExportBlob: vi.fn(), syncReminder: vi.fn() }))
vi.mock('./MobileOnboarding.jsx', () => ({ ConnectSheet: () => null }))
vi.mock('../sheets.jsx', () => ({ starterPlanSheet: vi.fn(), confirmSheet: vi.fn(), importFromApp: vi.fn(), importFromHevy: vi.fn(), equipmentProfileSheet: vi.fn(), plateInventorySheet: vi.fn(), menuSheet: vi.fn() }))

import Settings from './Settings.jsx'
globalThis.__APP_VERSION__ ??= 'test'

let host, root
const onError = e => { mocks.errors.push(e.error || e.message); e.preventDefault?.() }
beforeEach(() => {
  mocks.S = { unit: 'kg', restSec: 90, restPauseSec: 15, sound: true, vibrate: true, effort: 'none', gifSize: 'full', lang: 'en', workouts: [], routines: [], exWeights: {}, equipProfiles: [{ id: 'p1', name: 'Home', equipment: [] }], activeEquipId: 'p1', reminder: { on: false, time: '17:30' } }
  mocks.user = { id: 'u1', name: 'Me' }
  mocks.navs = []; mocks.errors = []
  window.addEventListener('error', onError)
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => { window.removeEventListener('error', onError); act(() => root.unmount()); host.remove() })

const row = title => [...host.querySelectorAll('.lrow')].find(r => r.querySelector('.lrow-t')?.textContent === title)
const tap = async el => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }

describe('Settings → Nutrition row', () => {
  it('opens /nutrition when tapped, with no error thrown in the handler', async () => {
    act(() => root.render(<Settings />))
    const r = row('Nutrition')
    expect(r, 'a signed-in profile sees the row').toBeTruthy()
    expect(r.tagName).toBe('BUTTON')
    await tap(r)
    expect(mocks.errors).toEqual([])
    expect(mocks.navs).toEqual([['/nutrition']])
  })

  it('goes where the Home card goes, as an absolute path (never a relative one)', async () => {
    act(() => root.render(<Settings />))
    await tap(row('Nutrition'))
    expect(mocks.navs[0][0]).toBe('/nutrition')
    expect(mocks.navs[0][0].startsWith('/')).toBe(true)
  })

  it('the other root rows still navigate (the harness is real)', async () => {
    act(() => root.render(<Settings />))
    await tap(row('Workout'))
    expect(mocks.navs.at(-1)).toEqual(['/settings/workout'])
  })

  it('a guest has no Nutrition row (guests never reach the server)', () => {
    mocks.user = null
    act(() => root.render(<Settings />))
    expect(row('Nutrition')).toBeUndefined()
  })
})
