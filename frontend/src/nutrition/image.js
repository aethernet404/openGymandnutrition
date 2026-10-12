// Photo → a small JPEG, on the phone, before anything is uploaded.
//
// Two reasons it is not optional. Size: a modern phone photo is 3–8 MB, the API takes 5 MB a
// request, and the model reads a 1280 px picture of a plate as well as a 4000 px one. Privacy:
// re-encoding through a canvas drops everything but the pixels — no GPS position, no timestamp,
// no camera serial — so what leaves the device is the meal and nothing else.

export const MAX_EDGE = 1280
export const QUALITY = 0.82
export const MAX_BYTES = 2 * 1024 * 1024

/** Scale (w, h) to fit `max` on the long edge; never enlarges. */
export function fitWithin(w, h, max = MAX_EDGE) {
  const k = Math.min(1, max / Math.max(w, h))
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }
}

const defaultEnv = () => ({
  createImageBitmap: globalThis.createImageBitmap?.bind(globalThis),
  makeCanvas: () => Object.assign(document.createElement('canvas'), {}),
  makeImage: () => new Image(),
  objectUrl: b => URL.createObjectURL(b),
  revoke: u => URL.revokeObjectURL(u),
  readAsDataUrl: blob => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
})

async function load(file, env) {
  if (env.createImageBitmap) {
    try { return { src: await env.createImageBitmap(file, { imageOrientation: 'from-image' }) } } catch { /* fall back to <img> */ }
  }
  const url = env.objectUrl(file)
  try {
    const img = env.makeImage()
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('decode')); img.src = url })
    return { src: img, width: img.naturalWidth || img.width, height: img.naturalHeight || img.height }
  } finally { env.revoke(url) }
}

/**
 * @param {Blob} file
 * @returns {Promise<{ base64:string, bytes:number, width:number, height:number, previewUrl:string }>}
 */
export async function downscaleToJpeg(file, { maxEdge = MAX_EDGE, quality = QUALITY, maxBytes = MAX_BYTES, env = defaultEnv() } = {}) {
  let loaded
  try { loaded = await load(file, env) } catch { throw new Error('Could not read this photo. Try a JPEG or PNG.') }
  const sw = loaded.width ?? loaded.src.width, sh = loaded.height ?? loaded.src.height
  if (!sw || !sh) throw new Error('Could not read this photo. Try a JPEG or PNG.')
  const { w, h } = fitWithin(sw, sh, maxEdge)
  const canvas = env.makeCanvas()
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'          // JPEG has no alpha: a transparent PNG would otherwise go black
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(loaded.src, 0, 0, w, h)
  loaded.src.close?.()

  let q = quality, blob = null
  for (let i = 0; i < 4; i++) {
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', q))
    if (blob && blob.size <= maxBytes) break
    q = Math.max(0.4, q - 0.15)
  }
  if (!blob || blob.size > maxBytes) throw new Error('This photo is too large to send even after shrinking it.')
  const dataUrl = await env.readAsDataUrl(blob)
  return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), bytes: blob.size, width: w, height: h, previewUrl: env.objectUrl(blob) }
}
