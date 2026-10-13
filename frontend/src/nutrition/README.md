# frontend/src/nutrition

All of the Nutrition UI. Wired into the app by one route (`App.jsx`), one Home card, one Settings row.
Strings go through `nt()` (see `i18n.js`) so the upstream locale packs stay untouched.

## Barcode scanning
Order of preference, on every device:

1. **Photo of the barcode** (always offered): `<input type=file capture=environment>` — the phone's own
   camera — decoded in the page by `barcode-decode.js` (EXIF orientation applied, scaled to 1600 px,
   then 2400 px if nothing was found; all four rotations tried). The decoder is `zxing-wasm` (reader
   build, ~0.97 MB wasm / 0.42 MB gzipped), lazy-loaded on first use and served from the app's own origin.
2. **Live scan** (optional extra): the browser's `BarcodeDetector` or the app's ML Kit scanner.
   Offered only where `scanMethods()` finds it; if the camera cannot start the screen says why.
3. **Typing** the number: always there.

`barcode.js` holds the pure decisions (which methods exist, what a result means, camera error text).
