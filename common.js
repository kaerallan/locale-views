// Shared helpers for the watch page and the stats page.
(function () {
  const CFG = window.TRACKER_CONFIG;

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
  };

  const isDemo = !CFG.ENDPOINT_URL;
  const DEMO_KEY = "tv_demo_views";

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  // Send one qualified view. Resolves to the server's JSON reply.
  async function sendView(record) {
    if (isDemo) {
      const all = store.get(DEMO_KEY, []);
      if (!all.some(r => r.videoId === record.videoId && r.viewerId === record.viewerId)) {
        all.push(Object.assign({ ts: new Date().toISOString() }, record));
        store.set(DEMO_KEY, all);
      }
      return { ok: true, demo: true };
    }
    // text/plain avoids a CORS preflight, which Apps Script can't answer.
    const res = await fetch(CFG.ENDPOINT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(record),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Server rejected the view");
    return json;
  }

  // Fetch per-town totals: { ok, total, towns: [{town, count}], updated }
  async function fetchStats(videoId) {
    if (isDemo) {
      const all = store.get(DEMO_KEY, []).filter(r => r.videoId === videoId);
      return { ok: true, demo: true, total: all.length, towns: groupTowns(all), updated: new Date().toISOString() };
    }
    const url = CFG.ENDPOINT_URL + (CFG.ENDPOINT_URL.includes("?") ? "&" : "?") +
      "video=" + encodeURIComponent(videoId) + "&_=" + Date.now();
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Could not load stats");
    return json;
  }

  // Same grouping rule as the Apps Script: case/spacing-insensitive.
  function groupTowns(records) {
    const map = new Map();
    for (const r of records) {
      const name = String(r.town || "").trim().replace(/\s+/g, " ");
      if (!name) continue;
      const key = name.toLowerCase();
      const cur = map.get(key) || { town: name, count: 0 };
      cur.count++;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.town.localeCompare(b.town));
  }

  window.TV = { CFG, store, isDemo, fmtTime, sendView, fetchStats };
})();
