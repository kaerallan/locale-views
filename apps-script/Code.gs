/**
 * Town Views — Google Apps Script backend.
 *
 * Every counted view must pass ALL of these server-side checks:
 *   1. The town is in TOWNS below (the page cannot add towns).
 *   2. At least MIN_SECONDS of real time passed on the SERVER's clock between
 *      "start" and "finish" — the browser's own timer is never trusted.
 *   3. The view's ticket is signed by this server and can be used only once.
 *   4. Only the newest view per device can finish (no stacking tabs).
 *
 * Setup (see README.md for the full walkthrough):
 *   - Run setup() once from the editor.
 *   - Deploy → Web app → Execute as: Me, Who has access: Anyone.
 *
 * After editing this file, publish it with Deploy → Manage deployments → Edit →
 * Version: New version (keeps the same URL).
 */

// ===================== EDIT THESE =====================
const VIDEO_ID = 'dQw4w9WgXcQ';
const MIN_SECONDS = 30;
const TOWNS = [
  'Bacnotan',
  'Balaoan',
  'Balballosa',
  'Ballogo',
  'Bangar',
  'Bangkusay',
  'Baraoas',
  'Carlatan',
  'Dangdangla',
  'Dar-aoan',
  'Dinanum',
  'Duplas Ext',
  'Guinabang',
  'Lipay Ext',
  'Lisqueb',
  'Luna',
  'Luzong Sur Ext',
  'Mameltac GWS',
  'Nagatiran',
  'Nagsabaran GWS',
  'Naguirangan',
  'Pagdalagan',
  'Pao-Balaoan',
  'Pao-San Fernando',
  'Paraoir',
  'San Fernando City',
  'San Juan',
  'San Pablo',
  'San Vicente',
  'Santiago Norte',
  'Santol Ext',
  'Sudipen',
  'Tallipugo',
  'Tanqui',
];
// ======================================================

const SHEET_NAME = 'Views';
const HEADERS = ['Timestamp', 'Town', 'Video ID', 'Session ID', 'Device ID', 'Seconds (server)', 'Device'];
const COL_SESSION = 4;                 // column D
const SESSION_MAX_AGE_MS = 6 * 3600 * 1000;
const STATS_CACHE_SECONDS = 15;

// ---------------------------------------------------------------- entry points

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'stats';
  try {
    if (action === 'config') {
      return json_({ ok: true, videoId: VIDEO_ID, minSeconds: MIN_SECONDS, towns: TOWNS });
    }
    if (action === 'stats') return statsResponse_();
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  let data;
  try {
    const raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > 4000) return json_({ ok: false, error: 'request too large' });
    data = JSON.parse(raw);
  } catch (err) {
    return json_({ ok: false, error: 'bad request' });
  }
  try {
    if (data.action === 'start') return start_(data);
    if (data.action === 'finish') return finish_(data);
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server error', retry: true });
  }
}

// ---------------------------------------------------------------- start a view

function start_(data) {
  const town = TOWNS.indexOf(data.town) >= 0 ? data.town : null;
  if (!town) return json_({ ok: false, error: 'unknown town' });
  const device = id_(data.device, 64);
  if (device.length < 8) return json_({ ok: false, error: 'bad device id' });
  const sid = Utilities.getUuid();
  const payload = { s: sid, t: town, v: VIDEO_ID, d: device, at: Date.now() };
  // Newest view wins for this device: older unfinished views from it can no longer finish.
  CacheService.getScriptCache().put('dev_' + device, sid, 21600);
  return json_({ ok: true, session: sign_(payload), town: town, minSeconds: MIN_SECONDS });
}

// ---------------------------------------------------------------- finish a view

function finish_(data) {
  const p = verify_(data.session);
  if (!p) return json_({ ok: false, error: 'invalid session' });
  if (p.v !== VIDEO_ID) return json_({ ok: false, error: 'video changed' });
  if (TOWNS.indexOf(p.t) < 0) return json_({ ok: false, error: 'town no longer listed' });

  const elapsedMs = Date.now() - p.at;
  if (elapsedMs > SESSION_MAX_AGE_MS) return json_({ ok: false, error: 'session expired' });
  if (elapsedMs < MIN_SECONDS * 1000) {
    return json_({ ok: false, error: 'too early', retryInMs: MIN_SECONDS * 1000 - elapsedMs });
  }

  const cache = CacheService.getScriptCache();
  if (cache.get('used_' + p.s)) return json_({ ok: true, duplicate: true, town: p.t });
  const latest = cache.get('dev_' + p.d);
  if (latest && latest !== p.s) return json_({ ok: false, error: 'replaced by a newer view on this device' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return json_({ ok: false, error: 'busy', retry: true });
  try {
    const sheet = sheet_();
    const last = sheet.getLastRow();
    if (last > 1) {
      const sids = sheet.getRange(2, COL_SESSION, last - 1, 1).getValues();
      for (let i = sids.length - 1; i >= 0; i--) {
        if (sids[i][0] === p.s) {
          cache.put('used_' + p.s, '1', 21600);
          return json_({ ok: true, duplicate: true, town: p.t });
        }
      }
    }
    const device = data.mobile === true ? 'mobile' : 'desktop';
    // Leading apostrophe stores the value as plain text (it isn't part of the value).
    sheet.appendRow([new Date(), "'" + p.t, "'" + p.v, "'" + p.s, "'" + p.d, Math.round(elapsedMs / 1000), device]);
    SpreadsheetApp.flush();
    cache.put('used_' + p.s, '1', 21600);
    try { cache.remove('stats'); } catch (err) { /* best effort */ }
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, town: p.t });
}

// ---------------------------------------------------------------- stats

function statsResponse_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('stats');
  if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);

  const counts = new Map(TOWNS.map(function (t) { return [t, 0]; }));
  let total = 0;
  const sheet = sheet_();
  const last = sheet.getLastRow();
  if (last > 1) {
    const rows = sheet.getRange(2, 2, last - 1, 2).getValues(); // B:C = Town, Video ID
    rows.forEach(function (r) {
      if (r[1] !== VIDEO_ID || !counts.has(r[0])) return;
      counts.set(r[0], counts.get(r[0]) + 1);
      total++;
    });
  }
  const towns = Array.from(counts, function (e) { return { town: e[0], count: e[1] }; })
    .sort(function (a, b) { return b.count - a.count || a.town.localeCompare(b.town); });
  const body = JSON.stringify({
    ok: true, videoId: VIDEO_ID, minSeconds: MIN_SECONDS,
    total: total, towns: towns, updated: new Date().toISOString(),
  });
  try { cache.put('stats', body, STATS_CACHE_SECONDS); } catch (err) { /* too big to cache: still serve it */ }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- one-time setup

/** Run this once from the Apps Script editor (select "setup" → Run). */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this script from the Google Sheet (Extensions → Apps Script) and run setup again.');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('SIGNING_KEY')) {
    props.setProperty('SIGNING_KEY', Utilities.getUuid() + Utilities.getUuid());
  }
  sheet_();
  console.log('Setup done. Spreadsheet: ' + ss.getName());
}

// ---------------------------------------------------------------- helpers

function sheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Run setup() once from the Apps Script editor.');
  const ss = SpreadsheetApp.openById(id);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function signingKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('SIGNING_KEY');
  if (!key) throw new Error('Run setup() once from the Apps Script editor.');
  return key;
}

function sign_(payload) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify(payload));
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, signingKey_()));
  return body + '.' + sig;
}

function verify_(token) {
  if (typeof token !== 'string' || token.length > 1000) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const expected = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], signingKey_()));
  if (!safeEqual_(expected, parts[1])) return null;
  try {
    const p = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
    if (typeof p.s !== 'string' || typeof p.t !== 'string' || typeof p.d !== 'string' || typeof p.at !== 'number') return null;
    return p;
  } catch (err) {
    return null;
  }
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function id_(v, max) {
  return String(v == null ? '' : v).replace(/[^\w-]/g, '').slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
