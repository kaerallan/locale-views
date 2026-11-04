// Stats page: per-town totals of qualified views.
(function () {
  const { CFG, isDemo, fetchStats } = window.TV;
  const $ = id => document.getElementById(id);

  if (isDemo) $("demoBanner").classList.remove("hidden");
  $("rule").textContent = "A view counts after someone plays the video for at least " +
    CFG.MIN_SECONDS + " seconds.";

  function render(data) {
    const towns = data.towns || [];
    const total = data.total || 0;
    const max = towns.length ? towns[0].count : 0;

    $("kTotal").textContent = total.toLocaleString();
    $("kTowns").textContent = towns.length.toLocaleString();
    $("kTop").textContent = towns.length ? towns[0].town : "–";
    $("kTop").title = $("kTop").textContent;

    const list = $("rows");
    list.innerHTML = "";
    if (!towns.length) {
      list.innerHTML = '<li class="empty">No counted views yet.</li>';
    }
    for (const t of towns) {
      const li = document.createElement("li");
      li.className = "row";
      const pct = total ? Math.round(100 * t.count / total) : 0;
      li.innerHTML =
        '<div class="row-head"><span class="name"></span>' +
        '<span class="count"><span class="c"></span><span class="pct"></span></span></div>' +
        '<div class="track"><div class="fill"></div></div>';
      li.querySelector(".name").textContent = t.town;
      li.querySelector(".c").textContent = t.count.toLocaleString();
      li.querySelector(".pct").textContent = pct + "%";
      li.querySelector(".fill").style.width = (max ? 100 * t.count / max : 0) + "%";
      list.appendChild(li);
    }
    const when = data.updated ? new Date(data.updated) : new Date();
    $("updated").textContent = "Updated " + when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  async function load() {
    try {
      render(await fetchStats(CFG.VIDEO_ID));
    } catch (err) {
      console.error(err);
      $("updated").innerHTML = '<span class="err">Couldn\'t load the latest numbers — retrying.</span>';
    }
  }

  load();
  setInterval(load, Math.max(10, CFG.STATS_REFRESH_SECONDS || 30) * 1000);
})();
