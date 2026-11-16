import { regionFromTimeZone } from './tz-region.js';

// The operator's declared location for the local store (W3: personal data,
// config only, never committed) wins. Without it, the OS timezone gives an
// approximate region (no network call; see tz-region.js for why not IP
// lookup). Anything malformed is reported with the reason and falls through to
// the timezone; with neither, localGeo is null and the globe shows "location
// not set" instead of a wrong place.
export function surfaceConfig(cfg = {}, { timeZone } = {}) {
  const g = cfg?.surface?.localGeo;
  let localGeoError = null;
  if (g != null) {
    const ok = g && Number.isFinite(g.lon) && Number.isFinite(g.lat) && g.lon >= -180 && g.lon <= 180 && g.lat >= -90 && g.lat <= 90;
    if (ok) return { localGeo: { city: String(g.city ?? ''), lon: g.lon, lat: g.lat, precision: String(g.precision ?? 'city'), source: String(g.source ?? 'operator') }, localGeoError };
    localGeoError = 'surface.localGeo needs numeric lon (-180..180) and lat (-90..90)';
  }
  const r = regionFromTimeZone(timeZone);
  if (!r) return { localGeo: null, localGeoError };
  return { localGeo: { city: r.region, lon: r.lon, lat: r.lat, precision: 'approximate', source: 'timezone', timeZone }, localGeoError };
}
