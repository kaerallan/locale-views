// Watch page: town picker + YouTube player + real watch-time tracking.
(function () {
  const { CFG, store, isDemo, fmtTime, sendView } = window.TV;
  const VID = CFG.VIDEO_ID;
  const OTHER = "__other__";

  // Per-device keys (scoped to this video)
  const K = {
    viewer: "tv_viewer_id",
    town: "tv_town",
    watched: "tv_watched_" + VID,   // seconds accumulated so far (survives reloads)
    counted: "tv_counted_" + VID,   // { town, at } once the view was recorded
    pending: "tv_pending_" + VID,   // a qualified view that failed to send
  };

  const $ = id => document.getElementById(id);
  const el = {
    demo: $("demoBanner"), title: $("title"), subtitle: $("subtitle"),
    stepTown: $("stepTown"), townForm: $("townForm"), townSelect: $("townSelect"),
    otherWrap: $("otherWrap"), townOther: $("townOther"), townContinue: $("townContinue"),
    stepWatch: $("stepWatch"), townName: $("townName"), changeTown: $("changeTown"),
    progressBlock: $("progressBlock"), progressText: $("progressText"), progressFill: $("progressFill"),
    status: $("status"), doneBanner: $("doneBanner"),
  };

  // ---------- viewer id ----------
  let viewerId = store.get(K.viewer, null);
  if (!viewerId) {
    viewerId = (crypto.randomUUID ? crypto.randomUUID() :
      Date.now().toString(36) + Math.random().toString(36).slice(2));
    store.set(K.viewer, viewerId);
  }

  // ---------- header ----------
  el.title.textContent = CFG.TITLE || "Watch our video";
  el.subtitle.textContent = CFG.SUBTITLE || "";
  document.title = CFG.TITLE || document.title;
  if (isDemo) el.demo.classList.remove("hidden");

  // ---------- town picker ----------
  for (const t of CFG.TOWNS) {
    const o = document.createElement("option");
    o.value = t; o.textContent = t;
    el.townSelect.appendChild(o);
  }
  if (CFG.ALLOW_OTHER_TOWN) {
    const o = document.createElement("option");
    o.value = OTHER; o.textContent = "Other (type it in)";
    el.townSelect.appendChild(o);
  }

  function chosenTown() {
    const v = el.townSelect.value;
    if (v === OTHER) return el.townOther.value.trim().replace(/\s+/g, " ");
    return v;
  }
  function refreshTownButton() {
    el.otherWrap.classList.toggle("hidden", el.townSelect.value !== OTHER);
    el.townContinue.disabled = !chosenTown();
  }
  el.townSelect.addEventListener("change", () => {
    refreshTownButton();
    if (el.townSelect.value === OTHER) el.townOther.focus();
  });
  el.townOther.addEventListener("input", refreshTownButton);

  let town = store.get(K.town, "");
  const counted = () => store.get(K.counted, null);

  el.townForm.addEventListener("submit", e => {
    e.preventDefault();
    const t = chosenTown();
    if (!t) return;
    town = t;
    store.set(K.town, town);
    showWatch();
  });

  el.changeTown.addEventListener("click", () => {
    if (counted() && CFG.ONE_VIEW_PER_DEVICE) return; // already locked in
    el.stepWatch.classList.add("hidden");
    el.stepTown.classList.remove("hidden");
    if (CFG.TOWNS.includes(town)) el.townSelect.value = town;
    else if (CFG.ALLOW_OTHER_TOWN && town) { el.townSelect.value = OTHER; el.townOther.value = town; }
    refreshTownButton();
  });

  function showWatch() {
    el.stepTown.classList.add("hidden");
    el.stepWatch.classList.remove("hidden");
    el.townName.textContent = town;
    loadPlayer();
    renderProgress();
  }

  // ---------- watch-time tracking ----------
  let watched = Number(store.get(K.watched, 0)) || 0;
  let required = Math.max(1, Number(CFG.MIN_SECONDS) || 30);
  let player = null, playerLoaded = false, lastTick = null, sending = false;

  function renderProgress() {
    const c = counted();
    if (c && CFG.ONE_VIEW_PER_DEVICE) {
      el.progressBlock.classList.add("hidden");
      el.changeTown.classList.add("hidden");
      el.townName.textContent = c.town;
      el.doneBanner.textContent = "✓ Your view from " + c.town + " has been counted. Thank you!";
      el.doneBanner.classList.remove("hidden");
      el.status.textContent = "Feel free to keep watching.";
      el.status.className = "status";
      return;
    }
    const shown = Math.min(watched, required);
    el.progressText.textContent = fmtTime(shown) + " / " + fmtTime(required);
    el.progressFill.style.width = (100 * shown / required).toFixed(1) + "%";
  }

  function tick() {
    const now = performance.now();
    const playing = player && player.getPlayerState && player.getPlayerState() === YT.PlayerState.PLAYING;
    const visible = document.visibilityState === "visible";
    if (playing && visible && lastTick !== null) {
      // Count real elapsed time, capped so a frozen/background tab can't add a big jump.
      watched += Math.min((now - lastTick) / 1000, 1.5);
      store.set(K.watched, Math.round(watched * 10) / 10);
      renderProgress();
      if (watched >= required) qualify();
    }
    lastTick = (playing && visible) ? now : null;
  }

  async function qualify() {
    if (sending) return;
    if (counted() && CFG.ONE_VIEW_PER_DEVICE) return;
    sending = true;
    const record = {
      videoId: VID,
      town,
      viewerId,
      seconds: Math.round(watched),
      device: /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? "mobile" : "desktop",
    };
    store.set(K.pending, record);
    el.status.textContent = "Counting your view…";
    try {
      await sendView(record);
      store.remove(K.pending);
      store.set(K.counted, { town, at: new Date().toISOString() });
      if (!CFG.ONE_VIEW_PER_DEVICE) { watched = 0; store.set(K.watched, 0); }
      renderProgress();
      if (!CFG.ONE_VIEW_PER_DEVICE) {
        el.status.textContent = "✓ View counted for " + town + ".";
        el.status.className = "status ok";
      }
    } catch (err) {
      console.warn("Send failed, will retry:", err);
      el.status.textContent = "Couldn't reach the server — we'll retry automatically.";
      setTimeout(() => { sending = false; qualify(); }, 15000);
      return;
    }
    sending = false;
  }

  // ---------- YouTube player ----------
  function loadPlayer() {
    if (playerLoaded) return;
    playerLoaded = true;
    window.onYouTubeIframeAPIReady = () => {
      player = new YT.Player("player", {
        videoId: VID,
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            const dur = player.getDuration();
            if (dur && dur - 2 < required) required = Math.max(1, Math.floor(dur - 2));
            renderProgress();
          },
          onStateChange: e => {
            if (e.data === YT.PlayerState.PLAYING) {
              if (!counted() || !CFG.ONE_VIEW_PER_DEVICE) {
                el.status.textContent = "Watching… keep it playing to count your view.";
                el.status.className = "status";
              }
            } else if (e.data === YT.PlayerState.PAUSED && !counted()) {
              el.status.textContent = "Paused — watch time only counts while playing.";
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

  document.addEventListener("visibilitychange", () => { lastTick = null; tick(); });

  // ---------- start ----------
  refreshTownButton();
  const c = counted();
  if (c && CFG.ONE_VIEW_PER_DEVICE) { town = c.town; showWatch(); }
  else if (town) showWatch();

  // Retry a view that qualified earlier but failed to send.
  const pending = store.get(K.pending, null);
  if (pending && !(c && CFG.ONE_VIEW_PER_DEVICE)) {
    town = pending.town || town;
    watched = Math.max(watched, pending.seconds || required);
    qualify();
  }
})();
