// @vitest-environment happy-dom
//
// The optional live scanner: the real reason when it cannot start, and the camera released on every
// way out — a stream left running keeps the camera light on and drains the battery.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BarcodeScanner from './BarcodeScanner.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host, root, tracks, getUserMedia, detectResults
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  tracks = [{ stop: vi.fn() }, { stop: vi.fn() }]
  getUserMedia = vi.fn(async () => ({ getTracks: () => tracks }))
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
  detectResults = []
  globalThis.BarcodeDetector = class { detect() { return Promise.resolve(detectResults) } }
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { get() { return this._src ?? null }, set(v) { this._src = v }, configurable: true })   // happy-dom only accepts a real MediaStream
  HTMLMediaElement.prototype.play = vi.fn(async () => {})
  HTMLMediaElement.prototype.pause = vi.fn()
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true })
})
afterEach(() => { try { act(() => root.unmount()) } catch { /* already */ } host.remove(); delete globalThis.BarcodeDetector })

const mount = async props => { await act(async () => { root.render(<BarcodeScanner onFound={vi.fn()} onCancel={vi.fn()} {...props} />) }); await flush() }
const stopped = () => tracks.every(t => t.stop.mock.calls.length >= 1)

describe('BarcodeScanner', () => {
  it('opens the rear camera and shows the viewfinder', async () => {
    await mount()
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    expect(host.querySelector('video')).toBeTruthy()
    expect(stopped()).toBe(false)
  })

  it('stops the camera when the component goes away (closing the sheet)', async () => {
    await mount()
    act(() => root.unmount())
    expect(stopped()).toBe(true)
  })

  it('stops the camera the moment a code is found, and hands over the digits', async () => {
    const onFound = vi.fn()
    detectResults = [{ rawValue: 'not food' }, { rawValue: '3017620422003', format: 'ean_13' }]
    await mount({ onFound })
    await act(async () => { await new Promise(r => setTimeout(r, 450)) })
    expect(onFound).toHaveBeenCalledWith('3017620422003')
    expect(stopped()).toBe(true)
  })

  it('Cancel releases the camera too', async () => {
    const onCancel = vi.fn()
    await mount({ onCancel })
    const cancel = [...host.querySelectorAll('button')].find(b => b.textContent === 'Cancel')
    await act(async () => { cancel.click() })
    expect(onCancel).toHaveBeenCalled()
    act(() => root.unmount())
    expect(stopped()).toBe(true)
  })

  it('stops the camera when the page goes to the background', async () => {
    await mount()
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(stopped()).toBe(true)
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  })

  it.each([
    ['NotAllowedError', /permission was denied/],
    ['NotFoundError', /No camera was found/],
    ['NotReadableError', /another app/]
  ])('shows the real reason when the camera cannot start: %s', async (name, words) => {
    getUserMedia.mockRejectedValue(Object.assign(new Error('browser says no'), { name }))
    const onError = vi.fn()
    await mount({ onError })
    expect(host.textContent).toMatch(words)
    expect(host.textContent).toContain(`(${name}: browser says no)`)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining(name))
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Back')).toBe(true)
  })

  it('a detector that will not construct releases the stream it already opened and says why', async () => {
    globalThis.BarcodeDetector = class { constructor() { throw Object.assign(new Error('formats unsupported'), { name: 'NotSupportedError' }) } }
    await mount()
    expect(host.textContent).toContain('NotSupportedError: formats unsupported')
    expect(stopped()).toBe(true)
  })

  it('if wiring the stream to the video fails, the stream is released and the reason shown', async () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { get() { return null }, set(v) { if (v) throw Object.assign(new Error('cannot attach'), { name: 'InvalidStateError' }) }, configurable: true })
    await mount()
    expect(stopped()).toBe(true)
    expect(host.textContent).toContain('InvalidStateError: cannot attach')
  })

  it('a permission prompt answered after the sheet was closed does not leave a stream running', async () => {
    let grant
    getUserMedia.mockImplementation(() => new Promise(r => { grant = r }))
    await mount()
    act(() => root.unmount())
    await act(async () => { grant({ getTracks: () => tracks }) }); await flush()
    expect(stopped()).toBe(true)
  })
})
