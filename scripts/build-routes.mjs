#!/usr/bin/env node
// Pre-bake all routes from the Google Sheet into public/routes.json so the
// rotas page can be served as a fully static HTML/JS app (e.g. on GitHub
// Pages). Re-run whenever the sheet has new entries.
//
// Usage:  npm run build:routes
//
// Reads from .env:
//   RWGPS_API_KEY
//   RWGPS_AUTH_TOKEN
//   RWGPS_COLLECTION_PRIVACY_CODE  (optional; used as a fallback per-route)
//
// Routes that fail to fetch are kept in the JSON with `latlngs: null` and an
// `error` field, so the page can still show their metadata.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Config ───────────────────────────────────────────────────────────────────
const SHEET_ID = '12v20busr7n0EAKWRW1htJiJX69sV5GB8YOhBkdxyhdw';
const SHEET_NAME = 'Geral';

const COLUMN_ROUTE = 'Rota';
const COLUMN_DATE = 'Data';
const COLUMN_NAME = 'Nome';
const COLUMN_IG = 'Post IG';
const COLUMN_NUM_PRIORITY = ['PH', 'BT', 'BP', 'S']; // first non-empty, non-'-' wins

const OUTPUT_PATH = path.join(REPO_ROOT, 'public', 'routes.json');
const CONCURRENCY = 4;            // parallel RWGPS fetches
const MAX_POINTS_PER_ROUTE = 400; // downsample to keep JSON small
const COORD_PRECISION = 5;        // ~1m precision

const RWGPS_API_KEY = process.env.RWGPS_API_KEY || '';
const RWGPS_AUTH_TOKEN = process.env.RWGPS_AUTH_TOKEN || '';
const RWGPS_PRIVACY_CODE = process.env.RWGPS_COLLECTION_PRIVACY_CODE || '';

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!RWGPS_API_KEY || !RWGPS_AUTH_TOKEN) {
    console.warn(
      'Warning: RWGPS_API_KEY/RWGPS_AUTH_TOKEN are not set. ' +
        'Public routes may still work; private/unlisted ones will return 401.',
    );
  }

  console.log(`Reading sheet "${SHEET_NAME}"…`);
  const rows = await fetchSheetRows(SHEET_ID, SHEET_NAME);
  console.log(`  ${rows.length} rows`);
  if (rows.length === 0) {
    throw new Error('Sheet returned 0 rows. Is it shared "anyone with the link"?');
  }

  const cols = rows[0].__cols;
  const colRoute = findCol(cols, COLUMN_ROUTE);
  const colDate = findCol(cols, COLUMN_DATE);
  const colName = findCol(cols, COLUMN_NAME);
  const colIG = findCol(cols, COLUMN_IG);
  const numCols = COLUMN_NUM_PRIORITY.map((n) => ({ name: n, idx: findCol(cols, n) }));
  if (colRoute == null) {
    throw new Error(`Column "${COLUMN_ROUTE}" not found. Headers: ${cols.join(', ')}`);
  }
  console.log('Columns:', { colRoute, colDate, colName, colIG, numCols });

  // Extract entries (one per unique route ID).
  const seen = new Set();
  const entries = [];
  for (const row of rows) {
    const id = extractRouteId(row[colRoute]);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const date = colDate != null ? toCellString(row[colDate]) : '';
    const dateMs = colDate != null ? parseGvizDate(row.__raw[colDate]) : null;
    const name = colName != null ? toCellString(row[colName]) : '';
    const igPost = colIG != null ? toCellString(row[colIG]) : '';
    const number = pickNumber(row, numCols);

    entries.push({ id, date, dateMs, name, igPost, number });
  }
  console.log(`Extracted ${entries.length} unique routes`);

  // Fetch GPX for each, with a small concurrency cap.
  console.log(`Fetching GPX (concurrency=${CONCURRENCY})…`);
  let done = 0;
  const results = await mapConcurrent(entries, CONCURRENCY, async (entry) => {
    let result;
    try {
      const data = await fetchRouteData(entry.id);
      result = {
        ...entry,
        latlngs: downsampleAndRound(data.latlngs),
        pois: data.pois,
      };
    } catch (err) {
      result = { ...entry, latlngs: null, pois: [], error: err.message };
    }
    done++;
    const ptsTag = result.latlngs ? `${result.latlngs.length}pts` : 'FAIL';
    const poiTag = result.pois?.length ? `${result.pois.length} POIs` : '';
    const tag = result.latlngs
      ? `ok (${ptsTag}${poiTag ? ', ' + poiTag : ''})`
      : `FAIL (${result.error})`;
    console.log(`  [${done}/${entries.length}] ${entry.id} — ${tag}`);
    return result;
  });

  const ok = results.filter((r) => r.latlngs).length;
  const failed = results.length - ok;
  console.log(`Done: ${ok} ok, ${failed} failed`);

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(
    OUTPUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sheet: { id: SHEET_ID, name: SHEET_NAME },
        routes: results,
      },
      null,
      2,
    ),
  );
  const stat = await fs.stat(OUTPUT_PATH);
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${(stat.size / 1024).toFixed(1)} KB)`);
}

// ─── Google Sheet fetch (gviz) ────────────────────────────────────────────────
async function fetchSheetRows(sheetId, sheetName) {
  const url =
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq` +
    `?tqx=out:json&sheet=${encodeURIComponent(sheetName)}&headers=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Sheet fetch ${r.status}`);
  const text = await r.text();
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open === -1 || close === -1) throw new Error('Unexpected gviz response');
  const data = JSON.parse(text.slice(open, close + 1));
  if (data.status === 'error') {
    const msg = (data.errors || []).map((e) => e.detailed_message || e.message).join('; ');
    throw new Error(`Sheet error: ${msg || 'unknown'}`);
  }
  const cols = (data.table.cols || []).map((c, i) => c.label || c.id || `col${i}`);
  const rows = (data.table.rows || []).map((r) => {
    const row = {};
    const raw = [];
    (r.c || []).forEach((cell, i) => {
      const formatted = cell == null ? null : (cell.f != null ? cell.f : cell.v);
      const rawVal = cell == null ? null : cell.v;
      row[i] = formatted;
      row[cols[i]] = formatted;
      raw[i] = rawVal;
    });
    Object.defineProperty(row, '__raw', { value: raw });
    return row;
  });
  if (rows.length > 0) Object.defineProperty(rows[0], '__cols', { value: cols });
  return rows;
}

function findCol(cols, name) {
  const target = name.trim().toLowerCase();
  for (let i = 0; i < cols.length; i++) {
    if ((cols[i] || '').trim().toLowerCase() === target) return i;
  }
  return null;
}

// ─── RideWithGPS fetch ────────────────────────────────────────────────────────
async function fetchRouteData(id) {
  // Attempt 1: native .gpx export with auth — includes <wpt> cues if present.
  const gpxUrl = decorateRwgps(new URL(`https://ridewithgps.com/routes/${id}.gpx`));
  const gpxRes = await fetch(gpxUrl);
  if (gpxRes.ok) {
    const text = await gpxRes.text();
    const latlngs = parseGpxLatLngs(text);
    const pois = parseGpxPois(text);
    if (latlngs.length > 0) return { latlngs, pois };
  }

  // Attempt 2: JSON endpoint → track_points + course_points (the JSON
  // equivalent of POIs, when present).
  const jsonUrl = decorateRwgps(new URL(`https://ridewithgps.com/routes/${id}.json`));
  const jsonRes = await fetch(jsonUrl, { headers: { Accept: 'application/json' } });
  if (!jsonRes.ok) {
    const body = (await jsonRes.text()).slice(0, 200);
    throw new Error(
      `gpx ${gpxRes.status}, json ${jsonRes.status} (${body || 'empty'})`,
    );
  }
  const data = await jsonRes.json();
  const pts = data?.route?.track_points || data?.track_points || [];
  if (!Array.isArray(pts) || pts.length === 0) {
    throw new Error('json had no track_points');
  }
  const latlngs = pts
    .map((p) => [p.y ?? p.lat, p.x ?? p.lon])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));

  // RWGPS JSON exposes POIs under route.points_of_interest; cues under
  // route.course_points (turn instructions — usually skipped for POI display).
  const rawPois = data?.route?.points_of_interest || data?.points_of_interest || [];
  const pois = rawPois
    .map((p) => ({
      lat: p.lat,
      lng: p.lng,
      name: p.n || p.name || '',
      sym: p.t || p.poi_type || '',
      type: p.t || p.poi_type || '',
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  return { latlngs, pois };
}

function decorateRwgps(url) {
  if (RWGPS_API_KEY) url.searchParams.set('apikey', RWGPS_API_KEY);
  if (RWGPS_AUTH_TOKEN) url.searchParams.set('auth_token', RWGPS_AUTH_TOKEN);
  url.searchParams.set('version', '2');
  if (RWGPS_PRIVACY_CODE) url.searchParams.set('privacy_code', RWGPS_PRIVACY_CODE);
  return url;
}

// Lightweight GPX parser (no DOM needed).
function parseGpxLatLngs(gpxText) {
  const out = [];
  const tagRe = /<(?:trkpt|rtept)\s+([^>/]*)\/?>/gi;
  let m;
  while ((m = tagRe.exec(gpxText))) {
    const attrs = m[1];
    const lat = /\blat\s*=\s*"([^"]+)"/i.exec(attrs);
    const lon = /\blon\s*=\s*"([^"]+)"/i.exec(attrs);
    if (lat && lon) {
      const la = parseFloat(lat[1]);
      const lo = parseFloat(lon[1]);
      if (Number.isFinite(la) && Number.isFinite(lo)) out.push([la, lo]);
    }
  }
  return out;
}

// Pull <wpt> elements (cues / POIs in RWGPS exports). Each looks like:
//   <wpt lat=".." lon=".."><name>..</name><sym>..</sym><type>..</type></wpt>
function parseGpxPois(gpxText) {
  const out = [];
  const wptRe = /<wpt\s+([^>]*)>([\s\S]*?)<\/wpt>/gi;
  let m;
  while ((m = wptRe.exec(gpxText))) {
    const lat = /\blat\s*=\s*"([^"]+)"/i.exec(m[1]);
    const lon = /\blon\s*=\s*"([^"]+)"/i.exec(m[1]);
    if (!lat || !lon) continue;
    const la = parseFloat(lat[1]);
    const lo = parseFloat(lon[1]);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const name = (/<name>([\s\S]*?)<\/name>/i.exec(m[2]) || [, ''])[1];
    const sym = (/<sym>([\s\S]*?)<\/sym>/i.exec(m[2]) || [, ''])[1];
    const type = (/<type>([\s\S]*?)<\/type>/i.exec(m[2]) || [, ''])[1];
    out.push({
      lat: round(la, COORD_PRECISION),
      lng: round(lo, COORD_PRECISION),
      name: decodeXml(name).trim(),
      sym: decodeXml(sym).trim(),
      type: decodeXml(type).trim(),
    });
  }
  return out;
}

function round(n, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function decodeXml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function toCellString(v) {
  if (v == null) return '';
  return String(v).trim();
}

function pickNumber(row, numCols) {
  for (const { name, idx } of numCols) {
    if (idx == null) continue;
    const v = toCellString(row[idx]);
    if (v && v !== '-') return { source: name, value: v };
  }
  return { source: '', value: '' };
}

function parseGvizDate(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  const s = String(raw);
  const m = s.match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    return new Date(+y, +mo, +d, +(h || 0), +(mi || 0), +(se || 0)).getTime();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function extractRouteId(cell) {
  if (cell == null) return null;
  const s = String(cell).trim();
  if (!s) return null;
  const m = s.match(/ridewithgps\.com\/routes\/(\d+)/i);
  if (m) return m[1];
  if (/^\d+$/.test(s)) return s;
  return null;
}

function downsampleAndRound(points) {
  if (!points || points.length === 0) return points;
  let out = points;
  if (out.length > MAX_POINTS_PER_ROUTE) {
    const stride = Math.ceil(out.length / MAX_POINTS_PER_ROUTE);
    const sampled = [];
    for (let i = 0; i < out.length; i += stride) sampled.push(out[i]);
    if (sampled[sampled.length - 1] !== out[out.length - 1]) sampled.push(out[out.length - 1]);
    out = sampled;
  }
  const f = Math.pow(10, COORD_PRECISION);
  return out.map(([la, lo]) => [Math.round(la * f) / f, Math.round(lo * f) / f]);
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

main().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
