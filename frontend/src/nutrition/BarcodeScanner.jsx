// A live barcode reader for the browser, on the browser's own BarcodeDetector (Chrome/Edge and
// Samsung Internet on Android; not iOS Safari — scannerSupport() says so and the sheet then offers
// only typing). The installed app scans with ML Kit instead (lib/scan.js), which is handled by the
// caller. No dependency: the existing jsQR path reads QR codes only, which is no use on an EAN.
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui.jsx'
import { nt } from './i18n.js'
import { SCAN_FORMATS, barcodeOf } from './lookup.js'

export default function BarcodeScanner({ onFound, onCancel }) {
  const videoRef = useRef(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let stream = null, timer = null, done = false
    const stop = () => { done = true; clearTimeout(timer); stream?.getTracks().forEach(tr => tr.stop()) }
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      } catch (e) { setError(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'denied' : 'unavailable'); return }
      if (done) { stream.getTracks().forEach(tr => tr.stop()); return }
      const v = videoRef.current
      if (!v) return
      v.srcObject = stream
      try { await v.play() } catch { /* the loop waits for frames */ }
      const detector = new BarcodeDetector({ formats: SCAN_FORMATS })
      const tick = async () => {
        if (done) return
        if (v.readyState >= 2) {
          try {
            const hits = await detector.detect(v)
            const code = hits.map(h => barcodeOf(h.rawValue)).find(Boolean)
            if (code && !done) { stop(); onFound(code); return }
          } catch { /* keep trying */ }
        }
        timer = setTimeout(tick, 200)
      }
      tick()
    })()
    return stop
  }, [onFound])

  return <>
    {error
      ? <div className="muted small" style={{ marginBottom: 12, lineHeight: 1.5 }}>
        {error === 'denied' ? nt('Camera access was denied. Allow it in your browser, or type the barcode instead.') : nt('No camera available here. Type the barcode instead.')}
      </div>
      : <div className="nut-cam"><video ref={videoRef} playsInline muted /><div className="nut-cam-line" /></div>}
    <div className="muted small" style={{ margin: '8px 0 12px', textAlign: 'center' }}>{!error && nt('Point the camera at the barcode.')}</div>
    <Button variant="ghost" className="dim" onClick={onCancel}>{nt('Cancel')}</Button>
  </>
}
