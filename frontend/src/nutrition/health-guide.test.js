// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATH, EXAMPLE, STEPS, RELIABILITY, endpointUrl, exampleJson, bearerHeader, GUIDE_URL } from './health-guide.js'

const raw = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/NUTRITION_APPLE_HEALTH.md'), 'utf8')
const doc = raw.replace(/\*/g, '').replace(/\s+/g, ' ')            // line breaks and bold markers do not matter

describe('the Apple Health guide data', () => {
  it('the address is this server’s own, under any sub-path', () => {
    expect(endpointUrl({ origin: 'https://mygym.example.com', pathname: '/' })).toBe('https://mygym.example.com/api/nutrition/health')
    expect(endpointUrl({ origin: 'https://example.com', pathname: '/gym/index.html' })).toBe('https://example.com/gym/api/nutrition/health')
    expect(endpointUrl({ origin: 'http://localhost:8080', pathname: '/' })).toBe('http://localhost:8080/api/nutrition/health')
  })
  it('the example is the one the server documents, with numbers for numbers', () => {
    const parsed = JSON.parse(exampleJson())
    expect(parsed).toEqual(EXAMPLE)
    expect(typeof parsed.active_kcal).toBe('number')
    expect(typeof parsed.resting_kcal).toBe('number')
    expect(typeof parsed.date).toBe('string')
    const inDoc = [...raw.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1]))
    expect(inDoc).toContainEqual(EXAMPLE)
  })
  it('the header value is “Bearer ” and the token', () => { expect(bearerHeader('ogh_x')).toBe('Bearer ogh_x') })
  it('the in-app steps and the repo guide say the same things', () => {
    expect(doc).toContain(`/${PATH}`)
    for (const term of ['Find Health Samples', 'Active Energy', 'Resting Energy', 'Calculate Statistics', 'Format Date', 'yyyy-MM-dd', 'Get Contents of URL', 'POST', 'Authorization', 'Bearer', 'Show Notification', 'Add to Home Screen', 'Time of Day', 'Run Immediately']) {
      expect(STEPS.join(' ') + ' ' + RELIABILITY).toContain(term === 'Time of Day' ? 'Time of Day' : term)
      expect(doc, term).toContain(term)
    }
    expect(STEPS.length).toBeLessThanOrEqual(10)
  })
  it('both are honest about reliability and about locked phones', () => {
    expect(RELIABILITY).toMatch(/locked/)
    expect(RELIABILITY).toMatch(/best effort/)
    expect(doc).toMatch(/not perfectly/)
    expect(doc).toMatch(/locked/)
  })
  it('links the guide in the repository', () => { expect(GUIDE_URL).toMatch(/^https:\/\/github\.com\/.+\/docs\/NUTRITION_APPLE_HEALTH\.md$/) })
})
