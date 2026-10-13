// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PATH, EXAMPLE, STEPS, RELIABILITY, endpointUrl, exampleJson, bearerHeader, GUIDE_URL, HAE_PATH, HAE_STEPS, HAE_METRICS, HAE_PREMIUM, HAE_GUIDE_URL, haeEndpointUrl } from './health-guide.js'

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

const haeRaw = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/NUTRITION_HEALTH_AUTO_EXPORT.md'), 'utf8')
const haeDoc = haeRaw.replace(/\*/g, '').replace(/\s+/g, ' ')

describe('the Health Auto Export guide data', () => {
  it('the address is this server’s own, under any sub-path, and a different route from the Shortcut’s', () => {
    expect(haeEndpointUrl({ origin: 'https://mygym.example.com', pathname: '/' })).toBe('https://mygym.example.com/api/nutrition/health/hae')
    expect(haeEndpointUrl({ origin: 'https://example.com', pathname: '/gym/index.html' })).toBe('https://example.com/gym/api/nutrition/health/hae')
    expect(HAE_PATH).not.toBe(PATH)
  })
  it('names the six metrics to turn on, and the in-app steps and the repo guide say the same things', () => {
    expect(HAE_METRICS).toEqual(['Active Energy', 'Resting Energy', 'Steps', 'Workouts', 'Exercise Minutes', 'Weight'])
    expect(haeDoc).toContain(`/${HAE_PATH}`)
    const steps = HAE_STEPS.join(' ')
    for (const term of ['Automations', 'REST API', 'Authorization', 'Bearer', 'Health Metrics', 'JSON', 'v2', 'Date Range', 'Sync Cadence', 'Manual Export', 'Summarize Data', ...HAE_METRICS.filter(x => x !== 'Workouts' && x !== 'Steps')]) {
      expect(steps, term).toContain(term)
      expect(haeDoc, term).toContain(term)
    }
    for (const metric of HAE_METRICS) expect(haeDoc, metric).toContain(metric)
    expect(HAE_STEPS.length).toBeLessThanOrEqual(10)
  })
  it('is honest that background sync is a premium feature and mentions the price the user saw', () => {
    expect(HAE_PREMIUM).toMatch(/premium feature/)
    expect(HAE_PREMIUM).toMatch(/\$6\.99/)
    expect(HAE_PREMIUM).toMatch(/could not verify/)
    expect(haeDoc).toMatch(/premium feature/)
    expect(haeDoc).toMatch(/\$6\.99/)
  })
  it('both say workout calories are never added on top of Burned', () => {
    expect(haeDoc).toMatch(/Workout calories are never added to Burned or Net/)
  })
  it('links the guide in the repository, and the Shortcut guide points to it', () => {
    expect(HAE_GUIDE_URL).toMatch(/^https:\/\/github\.com\/.+\/docs\/NUTRITION_HEALTH_AUTO_EXPORT\.md$/)
    expect(raw).toContain('NUTRITION_HEALTH_AUTO_EXPORT.md')
  })
})
