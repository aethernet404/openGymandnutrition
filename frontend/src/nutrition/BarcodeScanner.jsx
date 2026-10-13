// The OPTIONAL live viewfinder: the browser's BarcodeDetector on a camera stream (Chrome/Edge and
// Samsung Internet on Android). iPhone Safari has no BarcodeDetector, so there the photo scan in
// the Search tab is the way in and this component is never offered (scanMethods says so).
//
// Two promises: when the camera cannot start, the screen says the real reason (the browser's own
// error, in words, with its name after it), and the stream is stopped on every way out — found,
// cancelled, errored, unmounted, or the page going to the background.
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui.jsx'
import { nt } from './i18n.js'
import { SCAN_FORMATS, cameraErrorText, lookupCode } from './barcode.js'

export default function BarcodeScanner({ onFound, onCancel, onError }) {
  const videoRef = useRef(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let stream = null, timer = null, done = false
    const stop = () => {
      done = true
      clearTimeout(timer)
      stream?.getTracks().forEach(tr => tr.stop())
      const v = videoRef.current
      if (v) { try { v.pause(); v.srcObject = null } catch { /* nothing attached */ } }
      stream = null
    }
    const fail = e => { stop(); const text = cameraErrorText(e); setError(text); onError?.(text) }
    const hidden = () => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', hidden)
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      } catch (e) { fail(e); return }
      if (done) { stream.getTracks().forEach(tr => tr.stop()); return }
      // Anything that goes wrong from here on must still release the stream just opened.
      try {
        const detector = new BarcodeDetector({ formats: SCAN_FORMATS })
        const v = videoRef.current
        if (!v) { stop(); return }
        v.srcObject = stream
        try { await v.play() } catch { /* autoplay rules; the loop waits for frames */ }
        const tick = async () => {
          if (done) return
          if (v.readyState >= 2) {
            try {
              const hits = await detector.detect(v)
              const code = hits.map(h => lookupCode(h.rawValue)).find(Boolean)
              if (code && !done) { stop(); onFound(code); return }
            } catch { /* keep trying */ }
          }
          timer = setTimeout(tick, 200)
        }
        tick()
      } catch (e) { fail(e) }
    })()
    return () => { document.removeEventListener('visibilitychange', hidden); stop() }
  }, [onFound])

  return <>
    {error
      ? <div className="nut-banner warn"><span>{error}</span></div>
      : <div className="nut-cam"><video ref={videoRef} playsInline muted /><div className="nut-cam-line" /></div>}
    {!error && <div className="muted small" style={{ margin: '8px 0 12px', textAlign: 'center' }}>{nt('Point the camera at the barcode.')}</div>}
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={onCancel}>{error ? nt('Back') : nt('Cancel')}</Button>
  </>
}
