import { describe, expect, it, vi } from 'vitest'
import { fitWithin, downscaleToJpeg, MAX_EDGE } from './image.js'

describe('fitWithin', () => {
  it('shrinks the long edge to the limit, keeps the ratio, never enlarges', () => {
    expect(fitWithin(4000, 3000)).toEqual({ w: 1280, h: 960 })
    expect(fitWithin(3000, 4000)).toEqual({ w: 960, h: 1280 })
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 })
    expect(fitWithin(1280, 1280)).toEqual({ w: 1280, h: 1280 })
    expect(fitWithin(1, 5000)).toEqual({ w: 1, h: 1280 })
    expect(MAX_EDGE).toBe(1280)
  })
})

function fakeEnv({ w = 4032, h = 3024, sizes = [300000], bitmapFails = false, imageFails = false } = {}) {
  const drawn = []
  const qualities = []
  let n = 0
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ fillRect() {}, drawImage: (...a) => drawn.push(a), set fillStyle(_) {} }),
    toBlob: (cb, type, q) => { qualities.push(q); cb({ size: sizes[Math.min(n++, sizes.length - 1)], type }) }
  }
  const bitmap = { width: w, height: h, close: vi.fn() }
  return {
    drawn, qualities, canvas, bitmap,
    env: {
      createImageBitmap: bitmapFails ? async () => { throw new Error('no') } : async () => bitmap,
      makeCanvas: () => canvas,
      makeImage: () => { const i = {}; setTimeout(() => (imageFails ? i.onerror?.() : i.onload?.()), 0); Object.assign(i, { naturalWidth: w, naturalHeight: h }); return i },
      objectUrl: () => 'blob:preview', revoke: () => {},
      readAsDataUrl: async () => 'data:image/jpeg;base64,QUJDREVG'
    }
  }
}

describe('downscaleToJpeg', () => {
  it('draws a phone photo at 1280 px, gives back base64 without the data: prefix, and a preview', async () => {
    const f = fakeEnv()
    const r = await downscaleToJpeg(new Blob(['x']), { env: f.env })
    expect([f.canvas.width, f.canvas.height]).toEqual([1280, 960])
    expect(f.drawn[0].slice(1)).toEqual([0, 0, 1280, 960])
    expect(r).toMatchObject({ base64: 'QUJDREVG', bytes: 300000, width: 1280, height: 960, previewUrl: 'blob:preview' })
    expect(f.bitmap.close).toHaveBeenCalled()
    expect(f.qualities[0]).toBe(0.82)
  })

  it('lowers the quality until the picture fits the byte budget, then gives up with a sentence', async () => {
    const f = fakeEnv({ sizes: [3_000_000, 2_500_000, 1_500_000] })
    const r = await downscaleToJpeg(new Blob(['x']), { env: f.env })
    expect(r.bytes).toBe(1_500_000)
    expect(f.qualities).toEqual([0.82, expect.closeTo(0.67), expect.closeTo(0.52)])
    const huge = fakeEnv({ sizes: [9e6] })
    await expect(downscaleToJpeg(new Blob(['x']), { env: huge.env })).rejects.toThrow(/too large/)
  })

  it('falls back to an <img> when createImageBitmap cannot read the file, and explains an unreadable one', async () => {
    const f = fakeEnv({ bitmapFails: true })
    const r = await downscaleToJpeg(new Blob(['x']), { env: f.env })
    expect(r.width).toBe(1280)
    const bad = fakeEnv({ bitmapFails: true, imageFails: true })
    await expect(downscaleToJpeg(new Blob(['x']), { env: bad.env })).rejects.toThrow(/Could not read this photo/)
    const zero = fakeEnv({ w: 0, h: 0 })
    await expect(downscaleToJpeg(new Blob(['x']), { env: zero.env })).rejects.toThrow(/Could not read this photo/)
  })

  it('does not enlarge a small picture', async () => {
    const f = fakeEnv({ w: 640, h: 480 })
    await downscaleToJpeg(new Blob(['x']), { env: f.env })
    expect([f.canvas.width, f.canvas.height]).toEqual([640, 480])
  })
})
