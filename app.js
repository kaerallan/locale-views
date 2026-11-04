// Watch page: locale picker + YouTube player + server-verified views.
//
// One view = one "session":
//   start  -> the server issues a signed, server-timed ticket
//   watch  -> the page counts time only while the video is playing and on screen
//   finish -> once MIN seconds are watched, the ticket is sent back; the server
//             checks its own clock, the signature and that the ticket is unused.
// A view = one full MIN-seconds stretch of real playback. As soon as one is counted the
// next one starts, so a device that keeps watching earns one view per completed stretch
// (never two at the same time — the server enforces that too).
(function () {
  const { CFG, store, configured, fmtTime, api } = window.TV;
  const MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const K = { device: "tv_device_id", town: "tv_town", recent: "tv_recent_locales", pending: "tv_pending_finish" };
  const RECENT_MAX = 3;

  const $ = id => document.getElementById(id);
  const el = {
    title: $("title"), subtitle: $("subtitle"), notice: $("notice"), loading: $("loading"),
    stepTown: $("stepTown"), townForm: $("townForm"), townSelect: $("townSelect"), townContinue: $("townContinue"),
    recentWrap: $("recentWrap"), recentList: $("recentList"),
    stepWatch: $("stepWatch"), townName: $("townName"), changeTown: $("changeTown"),
    progressText: $("progressText"), progressFill: $("progressFill"), status: $("status"),
    counted: $("countedLine"),
    howTo: $("howTo"),
  };

  el.title.textContent = CFG.TITLE || "Watch our video";
  el.subtitle.textContent = CFG.SUBTITLE || "";

  function notice(msg) {
    el.notice.textContent = msg;
    el.notice.classList.toggle("hidden", !msg);
  }
  function setStatus(msg, kind) {
    el.status.textContent = msg;
    el.status.className = "status" + (kind ? " " + kind : "");
  }

  // ---------- device id (anonymous; only used so one device runs one view at a time) ----------
  let deviceId = store.get(K.device, null);
  if (!deviceId || !/^[\w-]{8,64}$/.test(deviceId)) {
    deviceId = crypto.randomUUID ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    store.set(K.device, deviceId);
  }

  // ---------- state ----------
  let server = null;            // { videoId, minSeconds, towns }
  let town = "";
  let player = null;
  let state = "idle";           // idle | starting | active | finishing | done
  let session = null;           // signed ticket from the server
  let sessionTown = "";
  let watched = 0;
  let lastMark = null;          // performance.now() when counting last (re)started
  let nextStartAt = 0;          // backoff for failed starts
  let finishTimer = null;
  let gen = 0;                  // bumps whenever a view is abandoned, so stale replies are ignored
  let endedWhileFinishing = false;
  let countedHere = 0;          // views counted on this page visit

  // ---------- load settings from the server ----------
  async function init() {
    if (!configured) {
      el.loading.classList.add("hidden");
      notice("This site isn't connected yet. The owner needs to set ENDPOINT_URL in config.js (see README).");
      return;
    }
    try {
      const res = await api("GET", { action: "config" });
      if (!res.ok) throw new Error(res.error || "config failed");
      server = res;
    } catch (err) {
      console.error(err);
      el.loading.textContent = "Something went wrong while loading. Check your connection and refresh the page.";
      return;
    }
    el.loading.classList.add("hidden");
    for (const t of server.towns) {
      const o = document.createElement("option");
      o.value = t; o.textContent = t;
      el.townSelect.appendChild(o);
    }
    renderProgress();

    const saved = store.get(K.town, "");
    if (server.towns.includes(saved)) { el.townSelect.value = saved; town = saved; }
    renderRecent();
    refreshTownButton();
    el.stepTown.classList.remove("hidden");
    setStatus("Press play to start. Your view counts once you've watched for " + fmtDuration(required()) + ".");
    for (const n of el.howTo.querySelectorAll(".need")) n.textContent = fmtDuration(required());
    el.howTo.classList.remove("hidden");

    resumePendingFinish();
  }

  // ---------- recent locales (quick picks under the dropdown) ----------
  function getRecent() {
    let list = store.get(K.recent, null);
    if (!Array.isArray(list)) {               // first visit after this feature: seed from the last choice
      const last = store.get(K.town, "");
      list = last ? [last] : [];
    }
    return list.filter(t => server && server.towns.includes(t)).slice(0, RECENT_MAX);
  }
  function rememberRecent(t) {
    store.set(K.recent, [t].concat(getRecent().filter(x => x !== t)).slice(0, RECENT_MAX));
  }
  function renderRecent() {
    const list = getRecent();
    el.recentList.innerHTML = "";
    for (const t of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = t;
      b.setAttribute("aria-label", "Watch from " + t);
      b.addEventListener("click", () => {
        el.townSelect.value = t;
        refreshTownButton();
        el.townForm.requestSubmit ? el.townForm.requestSubmit() : el.townForm.dispatchEvent(new Event("submit", { cancelable: true }));
      });
      el.recentList.appendChild(b);
    }
    el.recentWrap.classList.toggle("hidden", list.length === 0);
  }

  // ---------- locale picker ----------
  function refreshTownButton() { el.townContinue.disabled = !server || !server.towns.includes(el.townSelect.value); }
  el.townSelect.addEventListener("change", refreshTownButton);

  el.townForm.addEventListener("submit", e => {
    e.preventDefault();
    if (!server.towns.includes(el.townSelect.value)) return;
    town = el.townSelect.value;
    store.set(K.town, town);
    rememberRecent(town);
    renderRecent();
    el.townName.textContent = town;
    el.stepTown.classList.add("hidden");
    el.stepWatch.classList.remove("hidden");
    loadPlayer();
  });

  el.changeTown.addEventListener("click", () => {
    if (player && player.pauseVideo) player.pauseVideo();
    accrue();
    // An unfinished view is abandoned. A view that is already counted (or being
    // counted) stays counted: changing town must not re-arm the same playthrough.
    if (state === "idle" || state === "starting" || state === "active") resetView();
    el.stepWatch.classList.add("hidden");
    el.stepTown.classList.remove("hidden");
    refreshTownButton();
  });

  function resetView() {
    gen++;
    endedWhileFinishing = false;
    state = "idle";
    session = null;
    watched = 0;
    lastMark = null;
    renderProgress();
  }

  // ---------- watch-time accounting ----------
  function isPlaying() {
    return !!(player && player.getPlayerState && player.getPlayerState() === YT.PlayerState.PLAYING);
  }
  function isCounting() {
    return state === "active" && isPlaying() && document.visibilityState === "visible" &&
      !el.stepWatch.classList.contains("hidden");
  }
  function mediaTime() {
    try { const t = player.getCurrentTime(); return typeof t === "number" && isFinite(t) ? t : null; }
    catch (e) { return null; }
  }
  // Credits how much of the VIDEO actually played since the last mark — never more than the
  // real time that passed (so 2x speed doesn't count double), and nothing for stalls,
  // stutter, ads or seeking (a forward jump bigger than playback could explain is ignored).
  // Called on every tick AND on every play/pause/visibility change.
  let lastMedia = null;
  function accrue() {
    const now = performance.now();
    const t = isPlaying() ? mediaTime() : null;
    if (lastMark !== null && lastMedia !== null && t !== null) {
      const wall = (now - lastMark) / 1000;
      const media = t - lastMedia;
      const rate = (player.getPlaybackRate && player.getPlaybackRate()) || 1;
      if (media > 0 && media <= wall * Math.max(rate, 1) + 1.5) {
        watched += Math.min(media, wall, 2);
      }
    }
    if (isCounting() && t !== null) { lastMark = now; lastMedia = t; }
    else { lastMark = null; lastMedia = null; }
  }

  function required() { return server ? server.minSeconds : 30; }
  function fmtDuration(sec) {
    return sec % 60 === 0 ? (sec / 60) + (sec === 60 ? " minute" : " minutes") : sec + " seconds";
  }

  function renderProgress() {
    const req = required();
    const shown = state === "done" ? req : Math.min(watched, req);
    el.progressText.textContent = fmtTime(shown) + " / " + fmtTime(req);
    el.progressFill.style.width = (100 * shown / req).toFixed(1) + "%";
  }

  // ---------- keep the screen awake while the video plays (where the browser allows it) ----------
  let wakeLock = null, wakeBusy = false;
  async function keepAwake(want) {
    if (!("wakeLock" in navigator) || wakeBusy) return;
    wakeBusy = true;
    try {
      if (want && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        const w = wakeLock; wakeLock = null; await w.release();
      }
    } catch (e) { wakeLock = null; }   // denied (e.g. battery saver): nothing else to do
    wakeBusy = false;
  }

  function tick() {
    accrue();
    renderProgress();
    keepAwake(isPlaying() && document.visibilityState === "visible");
    if (state === "idle" && isPlaying() && document.visibilityState === "visible" &&
        Date.now() >= nextStartAt && !el.stepWatch.classList.contains("hidden")) {
      startView();
    }
    if (state === "active" && watched >= required()) finishView();
  }

  // ---------- start a view ----------
  async function startView() {
    state = "starting";
    const myGen = gen;
    setStatus("Getting things ready…");
    try {
      const res = await api("POST", { action: "start", town, device: deviceId });
      if (myGen !== gen || state !== "starting") return; // abandoned meanwhile
      if (!res.ok) {
        if (res.error === "unknown town") { notice("The list of locales was updated. Please refresh the page."); }
        throw Object.assign(new Error(res.error || "start failed"), { retry: true });
      }
      session = res.session;
      sessionTown = res.town;
      watched = 0;
      state = "active";
      lastMark = null;
      accrue();
      setStatus("You're watching. Keep it playing to get your view counted.");
    } catch (err) {
      console.warn("Start failed:", err);
      if (myGen !== gen || state !== "starting") return;
      state = "idle";
      nextStartAt = Date.now() + 8000;
      setStatus("We're having trouble connecting. Trying again in a moment.");
    }
  }

  // ---------- finish a view ----------
  function finishView(retryDelay) {
    if (state !== "active" && state !== "finishing") return;
    if (state === "active") {
      state = "finishing";
      addPending(session, sessionTown);
    }
    setStatus("Saving your view…");
    clearTimeout(finishTimer);
    sendFinish(session, retryDelay || 5000);
  }

  async function sendFinish(ticket, retryDelay) {
    let res;
    try {
      res = await api("POST", { action: "finish", session: ticket, mobile: MOBILE });
    } catch (err) {
      return scheduleFinishRetry(ticket, retryDelay, "We're having trouble connecting. Trying again in a moment.");
    }
    if (ticket !== session || state !== "finishing") return; // stale reply
    if (res.ok) {
      removePending(ticket);
      countedHere++;
      el.counted.textContent = "✓ " + countedHere + (countedHere === 1 ? " view" : " views") +
        " counted for " + res.town + " on this visit. Thank you!";
      el.counted.classList.remove("hidden");
      // The next view starts right away: every further full stretch counts again.
      resetView();
      setStatus("Keep watching if you like. Every extra " + fmtDuration(required()) + " counts as another view.");
      return;
    }
    if (res.retry || res.error === "too early") {
      const wait = res.retryInMs ? res.retryInMs + 500 : retryDelay;
      return scheduleFinishRetry(ticket, wait, res.error === "too early" ? "Almost there…" : "Lots of people are watching right now. Trying again in a moment.");
    }
    // Permanently rejected (expired, replaced by another tab, invalid): start over.
    removePending(ticket);
    resetView();
    nextStartAt = Date.now();
    setStatus(res.error === "replaced by a newer view on this device"
      ? "It looks like you're also watching in another tab or window, so this one won't be counted. Please watch in just one."
      : "Sorry, this view couldn't be counted. Keep watching and we'll try again.");
  }

  function scheduleFinishRetry(ticket, delay, msg) {
    setStatus(msg);
    clearTimeout(finishTimer);
    finishTimer = setTimeout(() => {
      if (state === "finishing" && ticket === session) sendFinish(ticket, Math.min(delay * 2, 60000));
    }, delay);
  }

  // ---------- views that qualified but whose "finish" never got through ----------
  // Kept as a list keyed by ticket, so recovering an old one never touches the current view.
  function getPending() {
    const list = store.get(K.pending, []);
    return Array.isArray(list) ? list.filter(p => p && typeof p.session === "string") : [];
  }
  function addPending(ticket, t) {
    const list = getPending().filter(p => p.session !== ticket);
    list.push({ session: ticket, town: t });
    store.set(K.pending, list.slice(-5));
  }
  function removePending(ticket) {
    store.set(K.pending, getPending().filter(p => p.session !== ticket));
  }

  // Called on page load: resend earlier qualified views in the background.
  // This never changes the state of the view on this page.
  function resumePendingFinish() {
    for (const p of getPending()) recoverPending(p, 5000);
  }
  async function recoverPending(p, delay) {
    let res;
    try {
      res = await api("POST", { action: "finish", session: p.session, mobile: MOBILE });
    } catch (err) {
      return setTimeout(() => recoverPending(p, Math.min(delay * 2, 60000)), delay);
    }
    if (res.ok) {
      removePending(p.session);
      notice("✓ Your earlier view from " + res.town + " was counted.");
      return;
    }
    if (res.retry || res.error === "too early") {
      return setTimeout(() => recoverPending(p, Math.min(delay * 2, 60000)), res.retryInMs ? res.retryInMs + 500 : delay);
    }
    removePending(p.session); // expired / invalid: nothing more to do
  }

  // ---------- YouTube player ----------
  let playerRequested = false;
  function loadPlayer() {
    if (playerRequested) return;
    playerRequested = true;
    window.onYouTubeIframeAPIReady = () => {
      player = new YT.Player("player", {
        videoId: server.videoId,
        // Standard youtube.com embed, started by the viewer, unmuted, visible and >= 200px:
        // the conditions under which YouTube counts embedded plays. origin/widget_referrer
        // let YouTube Analytics attribute these plays to this site ("Embedded player").
        playerVars: {
          playsinline: 1, rel: 0,
          origin: location.origin,
          widget_referrer: location.href,
        },
        events: {
          onError: e => {
            // 2 = bad id, 5 = HTML5 error, 100 = removed/private, 101/150 = embedding disabled
            setStatus(e.data === 101 || e.data === 150
              ? "This video can't be played here. Please let the organiser know."
              : "The video couldn't load. Please refresh the page.");
          },
          onStateChange: e => {
            if (e.data === YT.PlayerState.ENDED && state === "done") {
              resetView();             // replaying after the end starts a fresh view
              setStatus("Press play to watch again. It counts as another view.");
            } else if (e.data === YT.PlayerState.ENDED && state === "finishing") {
              endedWhileFinishing = true; // re-arm as soon as this view is confirmed
            } else if (e.data === YT.PlayerState.PAUSED && state === "active") {
              setStatus("Paused. Your time only adds up while the video is playing.");
            } else if (e.data === YT.PlayerState.PLAYING && state === "active") {
              setStatus("You're watching. Keep it playing to get your view counted.");
            }
            tick();
          },
        },
      });
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
    setInterval(tick, 1000);
  }

  document.addEventListener("visibilitychange", tick);

  init();
})();
