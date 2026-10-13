// Pure helpers for reading a barcode: which scan methods this device has, what a decoder's answer
// means, and what to tell the person when the camera will not start. No React, no camera, no wasm
// — those live in BarcodeScanner.jsx and barcode-decode.js — so every decision here is testable.
//
// The rule behind scanMethods: a photo of the barcode through the phone's own camera app
// (<input capture>) works on every phone that can take the meal photo, so it is ALWAYS offered
// and is the primary method. The live viewfinder (BarcodeDetector in Chrome/Android, ML Kit in the
// installed app) is an extra where it exists, never the only way, and typing is always there.

export const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e']          // BarcodeDetector's names
export const READ_FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE']              // the decoder's names

/** The check digit of a GTIN-8/12/13/14 (digits only) is right. */
export function gtinCheckOk(code) {
  if (!/^\d+$/.test(String(code)) || ![8, 12, 13, 14].includes(String(code).length)) return false
  const d = String(code).split('').map(Number)
  const check = d.pop()
  // Weights 3,1,3,1… counted from the digit next to the check digit.
  const sum = d.reverse().reduce((s, n, i) => s + n * (i % 2 === 0 ? 3 : 1), 0)
  return (10 - (sum % 10)) % 10 === check
}

/**
 * The code to look up, from a decoder result: digits only; a 12-digit UPC-A becomes the 13-digit
 * EAN form Open Food Facts files it under (a leading 0). The decoder already expands UPC-E to that
 * form. Anything else a barcode might say (a QR code, Code 128 text) is not a food barcode → null.
 */
export function lookupCode(text) {
  const d = String(text ?? '').replace(/\s/g, '')
  if (!/^\d+$/.test(d)) return null
  if (d.length === 12) return '0' + d
  return [8, 13, 14].includes(d.length) ? d : null
}

/** The first usable code among a decoder's results (best first), or null. */
export function pickCode(results) {
  for (const r of results || []) {
    if (r && r.isValid !== false) {
      const code = lookupCode(r.text)
      if (code) return { code, format: r.format || null }
    }
  }
  return null
}

/**
 * What this device can do. `photo` and `type` are always true. `live` is 'native' (the app's ML Kit
 * scanner), 'web' (BarcodeDetector + camera) or null, and when null `liveWhy` says why in a
 * sentence, for the screen.
 */
export async function scanMethods({ mobile = false, nav = globalThis.navigator, Detector = globalThis.BarcodeDetector, secure = globalThis.isSecureContext } = {}) {
  const base = { photo: true, type: true, live: null, liveWhy: null }
  if (mobile) return { ...base, live: 'native' }
  if (secure === false) return { ...base, liveWhy: 'The live scanner needs a secure (https) page.' }
  if (!nav?.mediaDevices?.getUserMedia) return { ...base, liveWhy: 'This browser does not give pages access to the camera.' }
  if (typeof Detector !== 'function') return { ...base, liveWhy: 'This browser has no built-in barcode reader (iPhone Safari does not). Use the photo option.' }
  try {
    const formats = typeof Detector.getSupportedFormats === 'function' ? await Detector.getSupportedFormats() : []
    if (SCAN_FORMATS.some(f => formats.includes(f))) return { ...base, live: 'web' }
    return { ...base, liveWhy: 'This browser’s barcode reader cannot read product barcodes (EAN/UPC).' }
  } catch (e) {
    return { ...base, liveWhy: 'The browser’s barcode reader would not start (' + (e?.message || e?.name || 'unknown error') + ').' }
  }
}

/** The real reason a camera did not start, in words, with the browser's own error name after it. */
export function cameraErrorText(e) {
  const name = e?.name || 'Error'
  const detail = ` (${name}${e?.message ? ': ' + e.message : ''})`
  const why = {
    NotAllowedError: 'Camera permission was denied. Allow the camera for this app in your phone’s settings, then try again.',
    SecurityError: 'The browser blocked the camera on this page (it needs https).',
    NotFoundError: 'No camera was found on this device.',
    NotReadableError: 'The camera is busy or not available — another app may be using it.',
    OverconstrainedError: 'The camera does not support the settings asked for.',
    AbortError: 'The camera stopped before it started.',
    TypeError: 'This browser cannot open the camera from a web page.'
  }[name]
  return (why || 'The camera could not be started.') + detail
}

/** A sentence for a photo in which no barcode was found. */
export const NO_CODE_TEXT = 'No barcode found in that photo. Fill the frame with the barcode, keep it sharp and flat on, avoid glare, and try again — or type the number printed under it.'
