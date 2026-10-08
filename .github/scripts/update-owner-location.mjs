import { readFile, writeFile } from 'node:fs/promises'

const username = 'abrahamliu00'
const output = new URL('../../owner-location.json', import.meta.url)
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'yuhan-site-location-sync',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
}

const profileResponse = await fetch(`https://api.github.com/users/${username}`, { headers })
if (!profileResponse.ok) throw new Error(`GitHub profile: HTTP ${profileResponse.status}`)
const profile = await profileResponse.json()
if (profile.login !== username) throw new Error('Unexpected GitHub profile')
const profileLocation = typeof profile.location === 'string' ? profile.location.trim() : ''
if (!profileLocation) {
  console.log('GitHub location is empty; keeping the last confirmed city')
  process.exit(0)
}

let previous = {}
try { previous = JSON.parse(await readFile(output, 'utf8')) } catch {}
if (previous.profileLocation === profileLocation &&
    Number.isFinite(previous.lat) && Number.isFinite(previous.lng)) {
  console.log(`GitHub location is still ${profileLocation}; no geocoding needed`)
  process.exit(0)
}

async function geocoding(path, params) {
  const url = new URL(`https://geocoding-api.open-meteo.com/v1/${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Geocoding: HTTP ${response.status}`)
  return response.json()
}

const search = await geocoding('search', { name: profileLocation, count: 10, language: 'en', format: 'json' })
const results = (search.results ?? []).filter((place) =>
  Number.isInteger(place.id) && Number.isFinite(place.latitude) && Math.abs(place.latitude) <= 90 &&
  Number.isFinite(place.longitude) && Math.abs(place.longitude) <= 180 &&
  typeof place.name === 'string' && typeof place.country === 'string'
)
if (results.length === 0) throw new Error(`Could not locate GitHub profile location: ${profileLocation}`)

const city = profileLocation.split(',')[0].trim().toLocaleLowerCase('en')
const exact = results.filter((place) => place.name.toLocaleLowerCase('en') === city)
const candidates = exact.length ? exact : results
const ranked = [...candidates].sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
const best = ranked[0]
const second = ranked[1]
const qualified = profileLocation.includes(',')
if (!qualified && second && !(
  Number(best.population) >= 100_000 && Number(best.population) >= Number(second.population ?? 0) * 5
)) {
  throw new Error(`Ambiguous GitHub location "${profileLocation}"; add a country or region to the profile`)
}

const localized = await geocoding('get', { id: best.id, language: 'zh' })
if (localized.id !== best.id || typeof localized.name !== 'string' || typeof localized.country !== 'string') {
  throw new Error(`Chinese city label unavailable for ${profileLocation}`)
}

const location = {
  profileLocation,
  lat: best.latitude,
  lng: best.longitude,
  name: best.name,
  country: best.country,
  nameZh: localized.name.replace(/市$/, ''),
  countryZh: localized.country
}
await writeFile(output, JSON.stringify(location) + '\n')
console.log(`Updated globe destination from GitHub: ${profileLocation} → ${best.name}, ${best.country}`)
