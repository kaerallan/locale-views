/**
 * Town Views — Google Apps Script backend.
 *
 * Paste this whole file into Extensions → Apps Script of a Google Sheet,
 * then Deploy → New deployment → Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Copy the Web app URL into ENDPOINT_URL in config.js.
 *
 * POST  (body = JSON text)  → records one qualified view (deduped per video + viewer)
 * GET   ?video=VIDEO_ID     → { ok, total, towns: [{town, count}], updated }
 */

const SHEET_NAME = 'Views';
const HEADERS = ['Timestamp', 'Town', 'Video ID', 'Viewer ID', 'Seconds watched', 'Device'];
const MIN_SECONDS = 1;          // server-side sanity floor; real threshold lives in config.js
const STATS_CACHE_SECONDS = 15; // GET results are cached briefly to keep the sheet fast

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const town = clean_(data.town, 60);
    const videoId = id_(data.videoId, 20);
    const viewerId = id_(data.viewerId, 64);
    const seconds = Math.max(0, Math.round(Number(data.seconds) || 0));
    const device = data.device === 'mobile' ? 'mobile' : 'desktop';

    if (!town || !videoId || !viewerId) return json_({ ok: false, error: 'missing fields' });
    if (!/^[\w-]{6,20}$/.test(videoId)) return json_({ ok: false, error: 'bad video id' });
    if (seconds < MIN_SECONDS) return json_({ ok: false, error: 'not enough watch time' });

    const sheet = sheet_();
    const last = sheet.getLastRow();
    if (last > 1) {
      // Columns C:D = Video ID, Viewer ID
      const ids = sheet.getRange(2, 3, last - 1, 2).getValues();
      for (let i = 0; i < ids.length; i++) {
        if (ids[i][0] === videoId && ids[i][1] === viewerId) {
          return json_({ ok: true, duplicate: true });
        }
      }
    }
    // Leading apostrophe stores the value as plain text (it isn't part of the value).
    sheet.appendRow([new Date(), "'" + town, "'" + videoId, "'" + viewerId, seconds, device]);
    CacheService.getScriptCache().remove('stats_' + videoId);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  const videoId = id_(e && e.parameter && e.parameter.video, 20);
  if (!videoId) return json_({ ok: false, error: 'add ?video=VIDEO_ID' });

  const cache = CacheService.getScriptCache();
  const cached = cache.get('stats_' + videoId);
  if (cached) return ContentService.createTextOutput(cached).setMimeType(ContentService.MimeType.JSON);

  const sheet = sheet_();
  const last = sheet.getLastRow();
  const groups = {};
  let total = 0;
  if (last > 1) {
    // Columns B:C = Town, Video ID
    const rows = sheet.getRange(2, 2, last - 1, 2).getValues();
    rows.forEach(function (r) {
      if (r[1] !== videoId) return;
      const name = String(r[0]).trim().replace(/\s+/g, ' ');
      if (!name) return;
      const key = name.toLowerCase();
      if (!groups[key]) groups[key] = { town: name, count: 0 };
      groups[key].count++;
      total++;
    });
  }
  const towns = Object.keys(groups).map(function (k) { return groups[k]; })
    .sort(function (a, b) { return b.count - a.count || a.town.localeCompare(b.town); });

  const body = JSON.stringify({ ok: true, total: total, towns: towns, updated: new Date().toISOString() });
  cache.put('stats_' + videoId, body, STATS_CACHE_SECONDS);
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function clean_(v, max) {
  // Strip characters that could be read as spreadsheet formulas.
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').replace(/^[=+\-@]+/, '').slice(0, max);
}

function id_(v, max) {
  return String(v == null ? '' : v).trim().replace(/[^\w-]/g, '').slice(0, max);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
