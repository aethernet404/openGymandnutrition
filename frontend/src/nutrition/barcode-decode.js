// Reading a barcode out of a still photo, in the page, with a bundled decoder: ZXing-C++ compiled
// to WebAssembly (`zxing-wasm`, reader build only). No request leaves the device — the wasm file
// is part of the app's own build and is fetched from the same origin the app came from — and none
// of this code is loaded until someone presses the scan button.
//
// The photo is turned into pixels first: createImageBitmap with imageOrientation 'from-image'
// applies the EXIF rotation a phone camera writes (an upright iPhone shot is stored sideways),
// falling back to an <img> element, which current Safari also orients. As a second line of
// defence the decoder itself tries all four rotations, so a barcode that still arrives sideways
// is read anyway. The picture is scaled so its long edge is at most 1600 px — big enough for the
// bars of a barcode filling a third of the frame, small enough to decode in well under a second —
// and, only if that finds nothing and the photo is larger, once more at up to 2400 px.
import { READ_FORMATS, pickCode } from './barcode.js'
import { fitWithin } from './image.js'

export const EDGES = [1600, 2400]

let loading = null
/** The decoder module, prepared with the wasm served from this app. Loaded once; a failure is not cached. */
export function loadEngine() {
  if (!loading) {
    loading = (async () => {
      const [mod, wasm] = await Promise.all([import('zxing-wasm/reader'), import('zxing-wasm/reader/zxing_reader.wasm?url')])
      await mod.prepareZXingModule({
        overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasm.default : prefix + path) },
        fireImmediately: true
      })
      return mod
    })().catch(e => { loading = null; throw e })
  }
  return loading
}

const defaultEnv = () => ({
  createImageBitmap: globalThis.createImageBitmap?.bind(globalThis),
  makeCanvas: () => document.createElement('canvas'),
  makeImage: () => new Image(),
  objectUrl: b => URL.createObjectURL(b),
  revoke: u => URL.revokeObjectURL(u)
})

/** File → { data, width, height } (RGBA pixels), scaled to at most `edge` on the long side. */
export async function renderPixels(file, edge, env = defaultEnv()) {
  let src, sw, sh, url
  try {
    if (env.createImageBitmap) {
      try { src = await env.createImageBitmap(file, { imageOrientation: 'from-image' }); sw = src.width; sh = src.height } catch { src = null }
    }
    if (!src) {
      url = env.objectUrl(file)
      const img = env.makeImage()
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('decode')); img.src = url })
      src = img; sw = img.naturalWidth || img.width; sh = img.naturalHeight || img.height
    }
  } catch { throw new Error('Could not open that photo. Try a JPEG or PNG.') } finally { if (url) env.revoke(url) }
  if (!sw || !sh) throw new Error('Could not open that photo. Try a JPEG or PNG.')
  const { w, h } = fitWithin(sw, sh, edge)
  const canvas = env.makeCanvas()
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h)
  ctx.drawImage(src, 0, 0, w, h)
  src.close?.()
  const px = ctx.getImageData(0, 0, w, h)
  return { data: px.data, width: w, height: h, longEdge: Math.max(sw, sh) }
}

/**
 * @param {Blob} file
 * @param {{ engine?: object, render?: Function, edges?: number[] }} o   injectable for tests
 * @returns {Promise<{ ok:true, code:string, format:string|null, edge:number }
 *                 | { ok:false, reason:'none'|'photo'|'engine', message:string }>}
 */
export async function decodeFile(file, { engine, render = renderPixels, edges = EDGES } = {}) {
  let eng
  try { eng = engine || await loadEngine() } catch (e) { return { ok: false, reason: 'engine', message: 'The barcode reader could not be loaded: ' + (e?.message || e) } }
  let longEdge = Infinity
  for (const edge of edges) {
    if (edge > edges[0] && longEdge <= edges[0]) break                        // the photo is no bigger than the first try
    let px
    try { px = await render(file, edge) } catch (e) { return { ok: false, reason: 'photo', message: e?.message || 'Could not open that photo.' } }
    longEdge = px.longEdge ?? Math.max(px.width, px.height)
    let results
    try {
      results = await eng.readBarcodes({ data: px.data, width: px.width, height: px.height, colorSpace: 'srgb' }, {
        formats: READ_FORMATS, tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 4
      })
    } catch (e) { return { ok: false, reason: 'engine', message: 'The barcode reader failed: ' + (e?.message || e) } }
    const hit = pickCode(results)
    if (hit) return { ok: true, ...hit, edge }
  }
  return { ok: false, reason: 'none', message: '' }
}
