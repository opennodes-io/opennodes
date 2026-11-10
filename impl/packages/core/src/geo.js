// Geography for locations (ONP-2 §3a): points for maps and distance queries. A location's own
// `geo` wins; otherwise a registry may derive an approximate point from its region code and
// MUST mark it (precision region or country, derived: true).
import { countryOf } from './regions.js';

// Precision of a point, finest first. Unknown values count as country.
export const GEO_PRECISIONS = ['facility', 'city', 'region', 'country'];
export const precisionRank = (p) => {
  const i = GEO_PRECISIONS.indexOf(p);
  return i < 0 ? GEO_PRECISIONS.length - 1 : i;
};

/**
 * Approximate label points (lat, lon) for region codes: countries, plus Canadian provinces and
 * territories and the US states that cloud regions sit in. For a region-only location these are
 * placeholders on a map, not where the datacentre is.
 */
export const REGION_POINTS = {
  // countries
  CA: [56.13, -106.35], US: [39.83, -98.58], MX: [23.63, -102.55], BR: [-14.24, -51.93],
  GB: [55.38, -3.44], IE: [53.41, -8.24], FR: [46.23, 2.21], DE: [51.17, 10.45], NL: [52.13, 5.29],
  BE: [50.50, 4.47], CH: [46.82, 8.23], AT: [47.52, 14.55], ES: [40.46, -3.75], PT: [39.40, -8.22],
  IT: [41.87, 12.57], PL: [51.92, 19.15], CZ: [49.82, 15.47], SE: [60.13, 18.64], NO: [60.47, 8.47],
  FI: [61.92, 25.75], DK: [56.26, 9.50], IS: [64.96, -19.02], IL: [31.05, 34.85], AE: [23.42, 53.85],
  SA: [23.89, 45.08], IN: [20.59, 78.96], SG: [1.35, 103.82], ID: [-0.79, 113.92], MY: [4.21, 101.98],
  CN: [35.86, 104.20], HK: [22.32, 114.17], TW: [23.70, 120.96], KR: [35.91, 127.77], JP: [36.20, 138.25],
  AU: [-25.27, 133.78], NZ: [-40.90, 174.89], ZA: [-30.56, 22.94], UA: [48.38, 31.17],
  EU: [50.85, 4.35], // reserved code: shown at Brussels
  // Canadian provinces and territories
  'CA-BC': [53.73, -127.65], 'CA-AB': [53.93, -116.58], 'CA-SK': [52.94, -106.45], 'CA-MB': [53.76, -98.81],
  'CA-ON': [51.25, -85.32], 'CA-QC': [52.94, -73.55], 'CA-NB': [46.57, -66.46], 'CA-NS': [44.68, -63.74],
  'CA-PE': [46.51, -63.42], 'CA-NL': [53.14, -57.66], 'CA-YT': [64.28, -135.00], 'CA-NT': [64.83, -124.85],
  'CA-NU': [70.30, -83.11],
  // US states with major cloud regions
  'US-VA': [37.43, -78.66], 'US-OH': [40.42, -82.91], 'US-OR': [43.80, -120.55], 'US-IA': [41.88, -93.10],
  'US-CA': [36.78, -119.42], 'US-TX': [31.97, -99.90], 'US-WA': [47.75, -120.74], 'US-NY': [43.30, -74.22],
  'US-IL': [40.63, -89.40], 'US-GA': [32.17, -82.90], 'US-AZ': [34.05, -111.09], 'US-NV': [38.80, -116.42],
  'US-UT': [39.32, -111.09], 'US-SC': [33.84, -81.16], 'US-NC': [35.76, -79.02],
};

/**
 * The point to draw for a location: its own `geo` (derived: false), else the label point of
 * its region, else of its country (derived: true). Null when nothing is known.
 */
export function pointFor(location) {
  const g = location?.geo;
  if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
    return { lat: g.lat, lon: g.lon, precision: GEO_PRECISIONS.includes(g.precision) ? g.precision : 'country', derived: false };
  }
  const code = String(location?.region ?? '').toUpperCase();
  if (REGION_POINTS[code] && code.includes('-')) return { lat: REGION_POINTS[code][0], lon: REGION_POINTS[code][1], precision: 'region', derived: true };
  const country = REGION_POINTS[countryOf(code)];
  return country ? { lat: country[0], lon: country[1], precision: 'country', derived: true } : null;
}

/** Great-circle distance in km (haversine, mean Earth radius). */
export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Parse "lat,lon" (e.g. from ?near=45.50,-73.57). Null when malformed or out of range. */
export function parsePoint(s) {
  const [lat, lon] = String(s ?? '').split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
