// @vitest-environment node
//
// The decoder against REAL barcodes: ZXing's own writer draws EAN-13, EAN-8, UPC-A and UPC-E; each
// is dropped into a larger, noisy, grey "photo" at awkward scales and rotations, and read back by
// the same reader build the app bundles (zxing-wasm, loaded here from node_modules instead of the
// app's asset URL). The writer is a test aid only — the app never ships it.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { decodeFile, renderPixels, EDGES } from './barcode-decode.js'

const require = createRequire(import.meta.url)
const dist = join(dirname(require.resolve('zxing-wasm/reader')), '..', '..')
let reader, writer

beforeAll(async () => {
  reader = await import('zxing-wasm/reader')
  writer = await import('zxing-wasm/writer')
  await reader.prepareZXingModule({ overrides: { wasmBinary: readFileSync(join(dist, 'reader/zxing_reader.wasm')) }, fireImmediately: true })
  await writer.prepareZXingModule({ overrides: { wasmBinary: readFileSync(join(dist, 'writer/zxing_writer.wasm')) }, fireImmediately: true })
}, 30000)

/* ---- a tiny photo studio ---- */
let seed = 12345
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

async function symbolOf(text, format) {
  const w = await writer.writeBarcode(text, { format, scale: 1, withQuietZones: true })
  if (w.error) throw new Error(w.error)
  return w.symbol                                   // { data: 1 byte per pixel (0 dark … 255 light), width, height }
}

/** Gray scene `W×H` with the symbol scaled by `k`, placed at (x, y), optional contrast and noise. */
function scene(sym, { W = 1600, H = 1200, k = 4, x = 400, y = 500, contrast = 1, noise = 0, bg = 150 } = {}) {
  const px = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    const g = bg + (noise ? (rand() - 0.5) * 2 * noise : 0)
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = g; px[i * 4 + 3] = 255
  }
  for (let sy = 0; sy < sym.height * k; sy++) {
    for (let sx = 0; sx < sym.width * k; sx++) {
      const v = sym.data[Math.floor(sy / k) * sym.width + Math.floor(sx / k)]
      const mid = 128, out = mid + (v - mid) * contrast + (noise ? (rand() - 0.5) * noise : 0)
      const X = x + sx, Y = y + sy
      if (X < W && Y < H) { const o = (Y * W + X) * 4; px[o] = px[o + 1] = px[o + 2] = out }
    }
  }
  return { data: px, width: W, height: H }
}

function rotate(img, quarter) {                      // clockwise quarter turns
  let cur = img
  for (let q = 0; q < quarter; q++) {
    const { width: w, height: h } = cur
    const out = new Uint8ClampedArray(w * h * 4)
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const s = (yy * w + xx) * 4, d = (xx * h + (h - 1 - yy)) * 4
      out[d] = cur.data[s]; out[d + 1] = cur.data[s + 1]; out[d + 2] = cur.data[s + 2]; out[d + 3] = 255
    }
    cur = { data: out, width: h, height: w }
  }
  return cur
}

const photo = img => ({ ...img, longEdge: Math.max(img.width, img.height) })
const engine = () => reader
const decode = (img, o = {}) => decodeFile(new Blob(['x']), { engine: engine(), render: async () => photo(img), ...o })

describe('decodeFile on real barcodes', () => {
  it.each([
    ['EAN13', '3017620422003', '3017620422003'],
    ['EAN8', '96385074', '96385074'],
    ['UPCA', '036000291452', '0036000291452'],      // UPC-A comes back in the 13-digit form Open Food Facts files it under
    ['UPCE', '01234565', '0012345000065']           // UPC-E comes back expanded
  ])('%s', async (format, text, expected) => {
    const r = await decode(scene(await symbolOf(text, format)))
    expect(r).toMatchObject({ ok: true, code: expected })
  })

  it('a barcode lying on its side or upside down in the photo (what a phone writes when EXIF is ignored)', async () => {
    const base = scene(await symbolOf('3017620422003', 'EAN13'))
    for (const q of [1, 2, 3]) expect(await decode(rotate(base, q)), `rotated ${q * 90}°`).toMatchObject({ ok: true, code: '3017620422003' })
  })

  it('a small barcode in a big, noisy, low-contrast frame', async () => {
    const r = await decode(scene(await symbolOf('3017620422003', 'EAN13'), { k: 3, x: 900, y: 300, contrast: 0.45, noise: 40 }))
    expect(r).toMatchObject({ ok: true, code: '3017620422003' })
  })

  it('nothing but a gray wall is reported as no barcode, not as an error', async () => {
    const wall = scene({ data: new Uint8Array(1), width: 1, height: 1 }, { k: 0, noise: 30 })
    expect(await decode(wall)).toEqual({ ok: false, reason: 'none', message: '' })
  })

  it('a QR code or a Code 128 in the picture is not a food barcode', async () => {
    const qr = await writer.writeBarcode('https://example.com/not-food', { format: 'QRCode', scale: 1, withQuietZones: true })
    expect(await decode(scene(qr.symbol, { k: 6 }))).toMatchObject({ ok: false, reason: 'none' })
    const c128 = await symbolOf('ABC-12345', 'Code128')
    expect(await decode(scene(c128, { k: 4 }))).toMatchObject({ ok: false, reason: 'none' })
  })

  it('a Code 128 that happens to hold a real food code is not mistaken for an EAN (formats are restricted)', async () => {
    const c128 = await symbolOf('3017620422003', 'Code128')
    expect(await decode(scene(c128, { k: 4 }))).toMatchObject({ ok: false, reason: 'none' })
  })
})

describe('decodeFile: attempts, and failures with real reasons', () => {
  it('tries the larger render only when the first finds nothing and the photo is bigger than the first size', async () => {
    const good = scene(await symbolOf('96385074', 'EAN8'))
    const bad = scene({ data: new Uint8Array(1), width: 1, height: 1 }, { k: 0 })
    const render = vi.fn(async (f, edge) => ({ ...(edge === EDGES[0] ? bad : good), longEdge: 4000 }))
    const r = await decodeFile(new Blob(['x']), { engine: engine(), render })
    expect(r).toMatchObject({ ok: true, code: '96385074', edge: EDGES[1] })
    expect(render.mock.calls.map(c => c[1])).toEqual(EDGES)
  })

  it('does not bother with a second render of a photo that was already smaller than the first', async () => {
    const bad = scene({ data: new Uint8Array(1), width: 1, height: 1 }, { k: 0, W: 800, H: 600 })
    const render = vi.fn(async () => ({ ...bad, longEdge: 800 }))
    expect(await decodeFile(new Blob(['x']), { engine: engine(), render })).toMatchObject({ ok: false, reason: 'none' })
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('stops at the first attempt that reads something', async () => {
    const render = vi.fn(async () => ({ ...scene(await symbolOf('3017620422003', 'EAN13')), longEdge: 4000 }))
    await decodeFile(new Blob(['x']), { engine: engine(), render })
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('a photo that cannot be opened says so', async () => {
    const r = await decodeFile(new Blob(['x']), { engine: engine(), render: async () => { throw new Error('Could not open that photo. Try a JPEG or PNG.') } })
    expect(r).toEqual({ ok: false, reason: 'photo', message: 'Could not open that photo. Try a JPEG or PNG.' })
  })

  it('a decoder that fails carries its own message through', async () => {
    const r = await decodeFile(new Blob(['x']), { engine: { readBarcodes: async () => { throw new Error('wasm trap') } }, render: async () => photo(scene({ data: new Uint8Array(1), width: 1, height: 1 }, { k: 0, W: 10, H: 10 })) })
    expect(r).toMatchObject({ ok: false, reason: 'engine' })
    expect(r.message).toContain('wasm trap')
  })
})

describe('renderPixels: orientation, scaling, fallbacks', () => {
  const env = (over = {}) => {
    const drawn = []
    const ctx = { fillRect() {}, drawImage: (...a) => drawn.push(a), getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), set fillStyle(_) {} }
    const canvas = { width: 0, height: 0, getContext: () => ctx }
    return {
      drawn, canvas,
      env: {
        createImageBitmap: vi.fn(async () => ({ width: 4032, height: 3024, close: vi.fn() })),
        makeCanvas: () => canvas,
        makeImage: () => { const i = {}; setTimeout(() => i.onload?.(), 0); return Object.assign(i, { naturalWidth: 3000, naturalHeight: 4000 }) },
        objectUrl: () => 'blob:x', revoke: vi.fn(),
        ...over
      }
    }
  }

  it('asks the browser to apply the EXIF orientation, and scales the long edge to the size requested', async () => {
    const f = env()
    const r = await renderPixels(new Blob(['x']), 1600, f.env)
    expect(f.env.createImageBitmap).toHaveBeenCalledWith(expect.anything(), { imageOrientation: 'from-image' })
    expect([f.canvas.width, f.canvas.height]).toEqual([1600, 1200])
    expect(r).toMatchObject({ width: 1600, height: 1200, longEdge: 4032 })
  })

  it('falls back to an <img> (which current Safari orients itself) and revokes its object URL', async () => {
    const f = env({ createImageBitmap: async () => { throw new Error('unsupported') } })
    const r = await renderPixels(new Blob(['x']), 1600, f.env)
    expect([r.width, r.height]).toEqual([1200, 1600])
    expect(f.env.revoke).toHaveBeenCalledWith('blob:x')
  })

  it('does not enlarge a small photo', async () => {
    const f = env({ createImageBitmap: async () => ({ width: 640, height: 480, close() {} }) })
    expect((await renderPixels(new Blob(['x']), 1600, f.env)).width).toBe(640)
  })

  it('an unreadable file gives a sentence', async () => {
    const f = env({ createImageBitmap: async () => { throw new Error('x') }, makeImage: () => { const i = {}; setTimeout(() => i.onerror?.(), 0); return i } })
    await expect(renderPixels(new Blob(['x']), 1600, f.env)).rejects.toThrow(/Could not open that photo/)
  })
})
