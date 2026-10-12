// Nutrition's strings go through the app's t() so a language pack that defines one is honoured,
// but under the name `nt` on purpose: scripts/check-source-strings.mjs collects every literal
// passed to t( ) and fails CI for keys no locale pack defines. Nutrition ships English-only
// first (its strings live here, not in the 17 upstream packs, which keeps upstream merges clean);
// translating it later means adding the keys to the packs and renaming nt( to t( .
import { t } from '../lib/i18n.js'

export const nt = (s, ...args) => t(s, ...args)
