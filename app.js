// Watch page: town picker + YouTube player + server-verified views.
//
// One view = one "session":
//   start  -> bot check (Turnstile) + server issues a signed, server-timed ticket
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
    progressText: $("progressText"), progressFill: $("progressFill"), status: $("status"), botCheck: $("botCheck"),
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

  // ---------- load settings from the server ----------
  async function init() {
    if (!configured) {
      el.loading.classList.add("hidden");
      notice("This site isn't connected yet. The owner needs to set ENDPOINT_URL in config.js (see README).");
      return;
    }
    if (!CFG.TURNSTILE_SITE_KEY) {
      el.loading.classList.add("hidden");
      notice("This site isn't fully set up yet. The owner needs to set TURNSTILE_SITE_KEY in config.js (see README).");
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
    loadTurnstile();

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
    if (state !== "finishing") resetView();   // an unfinished view is abandoned
    el.stepWatch.classList.add("hidden");
    el.stepTown.classList.remove("hidden");
    refreshTownButton();
  });

  function resetView() {
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
    setStatus("Checking you're a real viewer…");
    try {
      const token = await getTurnstileToken();
      if (state !== "starting") return; // abandoned meanwhile
      const res = await api("POST", { action: "start", town, device: deviceId, turnstile: token });
      if (state !== "starting") return;
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
      if (state !== "starting") return;
      state = "idle";
      nextStartAt = Date.now() + 8000;
      setStatus(err.message && err.message.indexOf("bot check") === 0
        ? "We couldn't confirm you're a real viewer. Retrying…"
        : "Couldn't reach the server. Retrying…");
    }
  }

  // ---------- finish a view ----------
  function finishView(retryDelay) {
    if (state !== "active" && state !== "finishing") return;
    if (state === "active") {
      state = "finishing";
      store.set(K.pending, { session, town: sessionTown });
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
      store.remove(K.pending);
      state = "done";
      session = null;
      renderProgress();
      setStatus("✓ Your view from " + res.town + " has been counted. Thank you! " +
        "To count another view, watch it again after the video ends.", "ok");
      return;
    }
    if (res.retry || res.error === "too early") {
      const wait = res.retryInMs ? res.retryInMs + 500 : retryDelay;
      return scheduleFinishRetry(ticket, wait, res.error === "too early" ? "Almost there…" : "Server busy — retrying…");
    }
    // Permanently rejected (expired, replaced by another tab, invalid): start over.
    store.remove(K.pending);
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

  // A view that qualified but whose "finish" never got through (e.g. the page was closed).
  function resumePendingFinish() {
    const p = store.get(K.pending, null);
    if (!p || typeof p.session !== "string") return;
    session = p.session;
    sessionTown = p.town;
    state = "finishing";
    sendFinish(p.session, 5000);
  }

  // ---------- Cloudflare Turnstile ----------
  let tsReady = null, tsWidget = null, tsWaiting = null;
  function loadTurnstile() {
    tsReady = new Promise((resolve, reject) => {
      window.onTurnstileLoad = resolve;
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad";
      s.async = true;
      s.onerror = () => reject(new Error("bot check couldn't load"));
      document.head.appendChild(s);
    });
    tsReady.catch(() => {});
  }
  function getTurnstileToken() {
    return tsReady.then(() => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { tsWaiting = null; reject(new Error("bot check timed out")); }, 120000);
      tsWaiting = {
        resolve: t => { clearTimeout(timeout); tsWaiting = null; resolve(t); },
        reject: e => { clearTimeout(timeout); tsWaiting = null; reject(e); },
      };
      if (tsWidget === null) {
        tsWidget = turnstile.render(el.botCheck, {
          sitekey: CFG.TURNSTILE_SITE_KEY,
          action: "start",
          appearance: "interaction-only",
          execution: "execute",
          callback: t => tsWaiting && tsWaiting.resolve(t),
          "error-callback": () => { tsWaiting && tsWaiting.reject(new Error("bot check error")); return true; },
          "expired-callback": () => {},
        });
      } else {
        turnstile.reset(tsWidget);
      }
      turnstile.execute(tsWidget);
    }));
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
