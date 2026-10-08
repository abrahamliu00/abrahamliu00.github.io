const geonamesUrl = (id) => `https://sws.geonames.org/${id}/about.rdf`

function field(xml, name) {
  return xml.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1]
}

function resourceId(xml, name) {
  return xml.match(new RegExp(`<${name} rdf:resource="https://sws\\.geonames\\.org/(\\d+)/"`))?.[1]
}

export function parseGeoNamesFeature(xml) {
  return {
    name: field(xml, 'gn:name'),
    code: xml.match(/<gn:featureCode rdf:resource="https:\/\/www\.geonames\.org\/ontology#([^\"]+)"/)?.[1],
    countryCode: field(xml, 'gn:countryCode'),
    lat: Number(field(xml, 'wgs84_pos:lat')),
    lng: Number(field(xml, 'wgs84_pos:long')),
    parentAdm2Id: resourceId(xml, 'gn:parentADM2')
  }
}

export async function fetchGeoNamesFeature(id, fetchImpl = fetch) {
  const response = await fetchImpl(geonamesUrl(id))
  if (!response.ok) throw new Error(`GeoNames ${id}: HTTP ${response.status}`)
  return parseGeoNamesFeature(await response.text())
}

/** Resolve Chinese sub-city place names to their prefecture-level city when GeoNames confirms it. */
export async function cityLabelForFeature(feature, country, fallback, fetchImpl = fetch) {
  if (country !== 'China' || !feature.parentAdm2Id) return { label: fallback, resolved: true }
  try {
    const parent = await fetchGeoNamesFeature(feature.parentAdm2Id, fetchImpl)
    if (parent.countryCode === 'CN' && parent.code === 'A.ADM2' && /\sShi$/i.test(parent.name ?? '')) {
      return { label: parent.name.replace(/\sShi$/i, ''), resolved: true }
    }
    return { label: fallback, resolved: true }
  } catch {
    // Keep the original label; the next scheduled run can retry the lookup.
    return { label: fallback, resolved: false }
  }
}
