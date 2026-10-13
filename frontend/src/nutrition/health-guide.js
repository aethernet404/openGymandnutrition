// What the Apple Health screen tells you to type into the Shortcut. Kept as data (and checked
// against docs/NUTRITION_APPLE_HEALTH.md by a test) so the in-app steps, the endpoint and the example
// cannot drift from the guide in the repository or from what the server accepts.
import { appBase } from '../lib/app-base.js'

export const PATH = 'api/nutrition/health'

/** Where the Shortcut posts: this server's address, whatever subpath it is served from. */
export function endpointUrl(loc = typeof location !== 'undefined' ? location : null) {
  return (loc?.origin || '') + appBase(loc) + PATH
}

export const EXAMPLE = Object.freeze({ date: '2026-10-13', active_kcal: 512, resting_kcal: 1650, steps: 8432 })
export const exampleJson = () => JSON.stringify(EXAMPLE, null, 2)
export const bearerHeader = token => 'Bearer ' + token

// The fork's copy of the full guide. `HEAD` is GitHub's name for whichever branch is the default.
export const GUIDE_URL = 'https://github.com/aethernet404/openGymandnutrition/blob/HEAD/docs/NUTRITION_APPLE_HEALTH.md'

export const STEPS = [
  'Make a token below and copy it. It is shown once.',
  'Open the Shortcuts app → + → name it “Send Health to openGym”.',
  'Add Find Health Samples: Type Active Energy, Start Date is today. Then Calculate Statistics → Sum. Do the same for Resting Energy (and Steps, if you want them).',
  'Add Format Date for the Current Date, with a Custom format of yyyy-MM-dd.',
  'Add If → the Active + Resting total is 0 → Stop. (A locked iPhone reads no Health data, and this keeps it from posting zeros.)',
  'Add Get Contents of URL: the address above, Method POST, Header Authorization = Bearer and your token, Request Body JSON with date (Text), active_kcal (Number), resting_kcal (Number), steps (Number, optional).',
  'Add Show Notification with the result, run it once, and allow the Health and network permissions it asks for.',
  'Optional: Add to Home Screen for a refresh button, and Automation → Time of Day → Run Immediately for a few times a day.'
]

export const RELIABILITY = 'iOS does not let a Shortcut read Health while the iPhone is locked, so an automation that fires then may send nothing. Treat automations as best effort; the Home Screen button always works when you tap it.'
