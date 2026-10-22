// Photos of a label: take one with the camera or choose several from the library, shrink each on the device, keep the total under
// what the server takes (the nginx body limit is 5 MB, the server accepts 3.3 MB of pictures), and never keep anything.
//
// Each photo is re-drawn through a canvas (image.js): EXIF orientation is applied ('from-image'), the long edge is 1280 px, it is
// saved as JPEG, and everything but the pixels (GPS, time, camera) is dropped. HEIC/HEIF: Safari (iPhone, iPad, Mac) opens
// them natively, so they are converted like any other photo; a browser that cannot decode one gets a plain message about
// how to share it as JPEG instead of a failure it cannot explain. No decoder is bundled for it (that would be a large new dependency).
import { MAX_EDGE, downscaleToJpeg } from './image.js'

export const MAX_PHOTOS = 4
export const TOTAL_MAX_BYTES = Math.floor(3.3 * 1024 * 1024)
export const PER_PHOTO_BYTES = 1.4 * 1024 * 1024
const STEPS = [[MAX_EDGE, 0.82], [1100, 0.72], [960, 0.65], [800, 0.55]]

export const isHeic = f => /image\/hei[cf]/i.test(f?.type || '') || /\.(heic|heif)$/i.test(f?.name || '')
export const totalBytes = list => list.reduce((n, p) => n + p.bytes, 0)

const heicText = name => `“${name}” is a HEIC photo, which this browser cannot open. Choose it again as a JPEG (on an iPhone: Settings → Camera → Formats → Most Compatible, or share the photo as JPEG), or take a new photo here.`

/**
 * Shrink `files` and add them to `current`. Never throws: whatever could not be added is in `problems`, in plain words.
 * @returns {Promise<{ photos: object[], problems: string[], tooBig: boolean }>}
 */
export async function addPhotos(current, files, { shrink = downscaleToJpeg, revoke = u => URL.revokeObjectURL(u) } = {}) {
  const photos = [...current]
  const problems = []
  const list = [...files]
  const room = MAX_PHOTOS - photos.length
  if (list.length > room) problems.push(room > 0 ? `Only ${MAX_PHOTOS} photos can be read at once; ${list.length - room} left out.` : `Only ${MAX_PHOTOS} photos can be read at once. Remove one first.`)
  for (const file of list.slice(0, Math.max(0, room))) {
    const name = file.name || 'photo'
    try {
      const p = await shrink(file, { maxEdge: STEPS[0][0], quality: STEPS[0][1], maxBytes: PER_PHOTO_BYTES })
      photos.push({ id: Math.random().toString(36).slice(2, 10), name, file, ...p })
    } catch (e) {
      problems.push(isHeic(file) ? heicText(name) : `“${name}”: ${e?.message || 'could not be read.'}`)
    }
  }
  // Together they must fit the server's limit: shrink all of them harder, a step at a time, from the originals.
  for (let i = 1; totalBytes(photos) > TOTAL_MAX_BYTES && i < STEPS.length; i++) {
    for (let j = 0; j < photos.length; j++) {
      try {
        const p = await shrink(photos[j].file, { maxEdge: STEPS[i][0], quality: STEPS[i][1], maxBytes: PER_PHOTO_BYTES })
        revoke(photos[j].previewUrl)
        photos[j] = { ...photos[j], ...p }
      } catch { /* keep the previous version */ }
    }
  }
  const tooBig = totalBytes(photos) > TOTAL_MAX_BYTES
  if (tooBig) problems.push('These photos are too large to send together, even after shrinking them. Remove one or two.')
  return { photos, problems, tooBig }
}

/** Without the photo at `index`; its preview address is released. */
export function removePhoto(photos, index, revoke = u => URL.revokeObjectURL(u)) {
  if (photos[index]) revoke(photos[index].previewUrl)
  return photos.filter((_, i) => i !== index)
}
