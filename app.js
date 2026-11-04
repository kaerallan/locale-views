// Watch page: town picker + YouTube player + server-verified views.
//
// One view = one "session":
//   start  -> the server issues a signed, server-timed ticket
//   watch  -> the page counts time only while the video is playing and on screen
//   finish -> once MIN seconds are watched, the ticket is sent back; the server
//             checks its own clock, the signature and that the ticket is unused.
// After a view is counted, another one can start once the video has ended and is replayed
// (or the page is reloaded).
(function () {
  const { CFG, store, configured, fmtTime, api } = window.TV;
  const MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const K = { device: "tv_device_id", town: "tv_town", pending: "tv_pending_finish" };

  const $ = id => document.getElementById(id);
  const el = {
    title: $("title"), subtitle: $("subtitle"), notice: $("notice"), loading: $("loading"),
    stepTown: $("stepTown"), townForm: $("townForm"), townSelect: $("townSelect"), townContinue: $("townContinue"),
    stepWatch: $("stepWatch"), townName: $("townName"), changeTown: $("changeTown"),
    progressText: $("progressText"), progressFill: $("progressFill"), status: $("status"),
  };

  el.title.textContent = CFG.TITLE || "Watch our video";
  el.subtitle.textContent = CFG.SUBTITLE || "";
  document.title = CFG.TITLE || document.title;

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
      el.loading.textContent = "Couldn't load — check your connection and refresh the page.";
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
    refreshTownButton();
    el.stepTown.classList.remove("hidden");

    resumePendingFinish();
  }

  // ---------- town picker ----------
  function refreshTownButton() { el.townContinue.disabled = !server || !server.towns.includes(el.townSelect.value); }
  el.townSelect.addEventListener("change", refreshTownButton);

  el.townForm.addEventListener("submit", e => {
    e.preventDefault();
    if (!server.towns.includes(el.townSelect.value)) return;
    town = el.townSelect.value;
    store.set(K.town, town);
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
  // Adds the time since the last mark (if we were counting), then re-marks.
  // Called on every tick AND on every play/pause/visibility change, so no time is lost or invented.
  function accrue() {
    const now = performance.now();
    if (lastMark !== null) watched += Math.min((now - lastMark) / 1000, 2);
    lastMark = isCounting() ? now : null;
  }

  function required() { return server ? server.minSeconds : 30; }

  function renderProgress() {
    const req = required();
    const shown = state === "done" ? req : Math.min(watched, req);
    el.progressText.textContent = fmtTime(shown) + " / " + fmtTime(req);
    el.progressFill.style.width = (100 * shown / req).toFixed(1) + "%";
  }

  function tick() {
    accrue();
    renderProgress();
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
    setStatus("Starting…");
    try {
      const res = await api("POST", { action: "start", town, device: deviceId });
      if (myGen !== gen || state !== "starting") return; // abandoned meanwhile
      if (!res.ok) {
        if (res.error === "unknown town") { notice("The town list has changed — please refresh the page."); }
        throw Object.assign(new Error(res.error || "start failed"), { retry: true });
      }
      session = res.session;
      sessionTown = res.town;
      watched = 0;
      state = "active";
      lastMark = null;
      accrue();
      setStatus("Watching… keep it playing to count your view.");
    } catch (err) {
      console.warn("Start failed:", err);
      if (myGen !== gen || state !== "starting") return;
      state = "idle";
      nextStartAt = Date.now() + 8000;
      setStatus("Couldn't reach the server. Retrying…");
    }
  }

  // ---------- finish a view ----------
  function finishView(retryDelay) {
    if (state !== "active" && state !== "finishing") return;
    if (state === "active") {
      state = "finishing";
      addPending(session, sessionTown);
    }
    setStatus("Counting your view…");
    clearTimeout(finishTimer);
    sendFinish(session, retryDelay || 5000);
  }

  async function sendFinish(ticket, retryDelay) {
    let res;
    try {
      res = await api("POST", { action: "finish", session: ticket, mobile: MOBILE });
    } catch (err) {
      return scheduleFinishRetry(ticket, retryDelay, "Couldn't reach the server — retrying…");
    }
    if (ticket !== session || state !== "finishing") return; // stale reply
    if (res.ok) {
      removePending(ticket);
      const ended = endedWhileFinishing;
      state = "done";
      session = null;
      renderProgress();
      setStatus("✓ Your view from " + res.town + " has been counted. Thank you! " +
        "To count another view, watch it again after the video ends.", "ok");
      if (ended) resetView();   // the video already ended, so a replay is a new view
      return;
    }
    if (res.retry || res.error === "too early") {
      const wait = res.retryInMs ? res.retryInMs + 500 : retryDelay;
      return scheduleFinishRetry(ticket, wait, res.error === "too early" ? "Almost there…" : "Server busy — retrying…");
    }
    // Permanently rejected (expired, replaced by another tab, invalid): start over.
    removePending(ticket);
    resetView();
    nextStartAt = Date.now();
    setStatus(res.error === "replaced by a newer view on this device"
      ? "This view was replaced by one in another tab or window."
      : "This view couldn't be counted (" + res.error + "). Keep watching to try again.");
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
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onStateChange: e => {
            if (e.data === YT.PlayerState.ENDED && state === "done") {
              resetView();             // replaying after the end starts a fresh view
              setStatus("Press play to watch again — it counts as another view.");
            } else if (e.data === YT.PlayerState.ENDED && state === "finishing") {
              endedWhileFinishing = true; // re-arm as soon as this view is confirmed
            } else if (e.data === YT.PlayerState.PAUSED && state === "active") {
              setStatus("Paused — watch time only counts while playing.");
            } else if (e.data === YT.PlayerState.PLAYING && state === "active") {
              setStatus("Watching… keep it playing to count your view.");
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
