import { readFile, writeFile } from 'node:fs/promises'
import { cityLabelForFeature, fetchGeoNamesFeature } from './geonames-city.mjs'

const token = process.env.STATABLE_API_KEY
if (!token) throw new Error('STATABLE_API_KEY is required')

const siteId = 3365133
const firstTrackingDay = '2026-09-29'
const output = new URL('../../visitor-history.json', import.meta.url)
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
})
const today = formatter.format(new Date())

function date(value) { return new Date(`${value}T00:00:00Z`) }
function day(value) { return value.toISOString().slice(0, 10) }

const ranges = []
for (let start = date(firstTrackingDay); start <= date(today);) {
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 365)
  const last = end < date(today) ? end : date(today)
  ranges.push([day(start), day(last)])
  start = new Date(last)
  start.setUTCDate(start.getUTCDate() + 1)
}

async function query(dateRange, dimension, offset = 0) {
  const body = { site_id: siteId, metrics: dimension ? ['visitors'] : ['pageviews'], date_range: dateRange }
  if (dimension) Object.assign(body, { dimensions: [dimension], limit: 1000, offset })
  const response = await fetch('https://statable.com/api/v1/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`Statable query failed: HTTP ${response.status}`)
  return response.json()
}

async function breakdown(dateRange, dimension) {
  const rows = []
  for (let offset = 0; ; offset += 1000) {
    const response = await query(dateRange, dimension, offset)
    rows.push(...(response.results ?? []))
    if (!response.meta?.has_more) return rows
  }
}

let previous = {}
try { previous = JSON.parse(await readFile(output, 'utf8')) } catch {}
const knownLocations = new Map((previous.points ?? [])
  .filter((point) => point.geonameId)
  .map((point) => [point.geonameId, point]))

const cityTotals = new Map()
const countries = new Set()
let pageviews = 0
for (const range of ranges) {
  const [totals, cities, countryRows] = await Promise.all([
    query(range), breakdown(range, 'visit:city'), breakdown(range, 'visit:country')
  ])
  pageviews += Number(totals.results?.[0]?.metrics?.pageviews ?? 0)
  for (const row of cities) {
    const id = String(row.dimensions?.['visit:city'] ?? '')
    if (!/^\d+$/.test(id)) continue
    const count = Number(row.metrics?.visitors ?? 0)
    if (!Number.isFinite(count) || count <= 0) continue
    const current = cityTotals.get(id) ?? { count: 0, label: '' }
    current.count += count
    current.label = String(row.labels?.['visit:city'] ?? current.label)
    cityTotals.set(id, current)
  }
  for (const row of countryRows) {
    const code = String(row.dimensions?.['visit:country'] ?? '')
    if (/^[A-Z]{2}$/.test(code)) countries.add(code)
  }
}

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' })
async function geocode(id) {
  const feature = await fetchGeoNamesFeature(id)
  const { lat, lng, countryCode: code } = feature
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !code) throw new Error(`GeoNames ${id}: coordinates unavailable`)
  return { lat, lng, c: countryNames.of(code) ?? code, feature }
}

const points = []
for (const [geonameId, city] of [...cityTotals].sort((a, b) => b[1].count - a[1].count).slice(0, 500)) {
  const known = knownLocations.get(geonameId)
  const location = known ?? await geocode(geonameId)
  let label = city.label || location.t || 'Unknown city'
  let cityResolved = known?.cityResolved === true
  if (location.c === 'China') {
    if (cityResolved) {
      label = known.t
    } else {
      const feature = location.feature ?? (await geocode(geonameId)).feature
      const result = await cityLabelForFeature(feature, location.c, label)
      label = result.label
      cityResolved = result.resolved
    }
  }
  points.push({ geonameId, lat: location.lat, lng: location.lng, t: label, c: location.c, v: city.count, ...(location.c === 'China' ? { cityResolved } : {}) })
}

await writeFile(output, JSON.stringify({
  status: 'ready', trackingStartedAt: firstTrackingDay, updatedAt: new Date().toISOString(),
  pageviews, countries: countries.size, points
}) + '\n')
console.log(`Updated all-time visitor history: ${pageviews} pageviews, ${countries.size} countries, ${points.length} cities`)
