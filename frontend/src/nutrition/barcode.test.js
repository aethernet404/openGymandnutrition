import { describe, expect, it } from 'vitest'
import { gtinCheckOk, lookupCode, pickCode, scanMethods, cameraErrorText, NO_CODE_TEXT } from './barcode.js'

describe('barcode helpers', () => {
  it('checks the GTIN check digit for EAN-8, UPC-A, EAN-13 and GTIN-14', () => {
    expect(gtinCheckOk('3017620422003')).toBe(true)     // EAN-13 (Nutella)
    expect(gtinCheckOk('96385074')).toBe(true)          // EAN-8
    expect(gtinCheckOk('036000291452')).toBe(true)      // UPC-A
    expect(gtinCheckOk('3017620422004')).toBe(false)
    expect(gtinCheckOk('123')).toBe(false)
    expect(gtinCheckOk('30176204220o3')).toBe(false)
    expect(gtinCheckOk(null)).toBe(false)
  })

  it('lookupCode: digits only; UPC-A becomes the 13-digit form; other lengths and non-numeric text are not food barcodes', () => {
    expect(lookupCode('3017620422003')).toBe('3017620422003')
    expect(lookupCode('036000291452')).toBe('0036000291452')
    expect(lookupCode('96385074')).toBe('96385074')
    expect(lookupCode(' 3017 6204 22003 ')).toBe('3017620422003')
    for (const bad of ['https://example.com/q', 'ABC-123', '12345', '123456789', '1234567890123456', '', null, undefined]) expect(lookupCode(bad), String(bad)).toBe(null)
  })

  it('pickCode takes the first valid food barcode, in the decoder’s order', () => {
    expect(pickCode([{ text: 'hello', format: 'QRCode' }, { text: '3017620422003', format: 'EAN13', isValid: true }])).toEqual({ code: '3017620422003', format: 'EAN13' })
    expect(pickCode([{ text: '3017620422003', isValid: false }, { text: '96385074', format: 'EAN8' }])).toEqual({ code: '96385074', format: 'EAN8' })
    expect(pickCode([])).toBe(null)
    expect(pickCode(null)).toBe(null)
    expect(pickCode([{ text: 'nope' }])).toBe(null)
  })
})

describe('scanMethods — the photo and the typing box are always there; the live scanner is an extra', () => {
  const nav = { mediaDevices: { getUserMedia() {} } }
  const Detector = formats => Object.assign(function () {}, { getSupportedFormats: async () => formats })

  it('iPhone Safari (a camera API, no BarcodeDetector): photo + typing, and the reason live is off', async () => {
    const m = await scanMethods({ nav, Detector: undefined, secure: true })
    expect(m).toMatchObject({ photo: true, type: true, live: null })
    expect(m.liveWhy).toMatch(/iPhone Safari does not/)
  })

  it('Chrome on Android (BarcodeDetector with EAN): live as well', async () => {
    expect(await scanMethods({ nav, Detector: Detector(['qr_code', 'ean_13']), secure: true })).toMatchObject({ photo: true, type: true, live: 'web', liveWhy: null })
  })

  it('the installed app: ML Kit is the live scanner', async () => {
    expect(await scanMethods({ mobile: true })).toMatchObject({ photo: true, type: true, live: 'native' })
  })

  it('every way live can be missing still leaves photo and typing, with a sentence', async () => {
    const cases = [
      [{ nav, Detector: Detector(['qr_code']), secure: true }, /cannot read product barcodes/],
      [{ nav, Detector: Detector([]), secure: true }, /cannot read product barcodes/],
      [{ nav: {}, Detector: Detector(['ean_13']), secure: true }, /does not give pages access to the camera/],
      [{ nav, Detector: Detector(['ean_13']), secure: false }, /https/],
      [{ nav, Detector: Object.assign(function () {}, { getSupportedFormats: async () => { throw new Error('boom') } }), secure: true }, /boom/]
    ]
    for (const [opts, words] of cases) {
      const m = await scanMethods(opts)
      expect(m.photo && m.type).toBe(true)
      expect(m.live).toBe(null)
      expect(m.liveWhy).toMatch(words)
    }
  })

  it('a detector without getSupportedFormats is treated as unable', async () => {
    const m = await scanMethods({ nav, Detector: function () {}, secure: true })
    expect(m.live).toBe(null)
    expect(m.photo).toBe(true)
  })
})

describe('cameraErrorText says the real reason', () => {
  it('names each browser error in words and keeps the browser’s own name and message after it', () => {
    const t = (name, message) => cameraErrorText(Object.assign(new Error(message), { name }))
    expect(t('NotAllowedError', 'Permission denied')).toMatch(/permission was denied.*settings.*\(NotAllowedError: Permission denied\)/s)
    expect(t('NotFoundError', 'x')).toMatch(/No camera was found/)
    expect(t('NotReadableError', 'x')).toMatch(/another app/)
    expect(t('SecurityError', 'x')).toMatch(/https/)
    expect(t('OverconstrainedError', 'x')).toMatch(/settings asked for/)
    expect(t('TypeError', 'x')).toMatch(/cannot open the camera/)
    expect(t('WeirdError', 'odd')).toBe('The camera could not be started. (WeirdError: odd)')
    expect(cameraErrorText(undefined)).toMatch(/could not be started/)
  })

  it('has a sentence for a photo with no barcode in it', () => {
    expect(NO_CODE_TEXT).toMatch(/No barcode found/)
    expect(NO_CODE_TEXT).toMatch(/type the number/)
  })
})
