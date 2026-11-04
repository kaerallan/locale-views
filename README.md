# Town Views — YouTube viewers by town

A static website (works on GitHub Pages) that:

- asks each viewer which town they're watching from,
- plays your YouTube video,
- measures how long they **actually play** it (paused time, hidden-tab time and skipping ahead don't count),
- counts a view only once they reach the minimum watch time,
- shows live totals per town on a results page.

Views are stored in a Google Sheet you own, through a small free Google Apps Script.

| File | What it is |
|---|---|
| `index.html` | Watch page (town picker + video + progress bar) |
| `stats.html` | Results page (views per town, auto-refreshing) |
| `config.js` | **The only file you need to edit** — video ID, minimum seconds, town list, backend URL |
| `apps-script/Code.gs` | Backend to paste into Google Apps Script |

---

## 1. Try it first (demo mode)

With `ENDPOINT_URL` left empty, the site runs in demo mode and saves views only in your own browser. Open `index.html` through any local web server, for example:

```bash
python -m http.server 8000
```

then visit http://localhost:8000. (Opening the file directly with `file://` won't load the YouTube player.)

## 2. Edit `config.js`

- `VIDEO_ID` — the part after `v=` in the YouTube link.
- `MIN_SECONDS` — how long someone has to watch before the view counts.
- `TOWNS` — your list of towns. `ALLOW_OTHER_TOWN: true` lets people type one that isn't listed.
- `ONE_VIEW_PER_DEVICE` — `true` counts each phone/computer once.

## 3. Set up the Google Sheet backend (≈5 minutes)

1. Create a new Google Sheet (any name).
2. In the sheet: **Extensions → Apps Script**.
3. Delete what's there, paste the contents of `apps-script/Code.gs`, and click **Save**.
4. Click **Deploy → New deployment**. Click the gear ⚙ → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy**, approve the permissions (Google will warn that the app isn't verified — click *Advanced → Go to project* since it's your own script).
6. Copy the **Web app URL** (ends in `/exec`) and paste it into `ENDPOINT_URL` in `config.js`.

Check it works: open `YOUR_WEB_APP_URL?video=YOUR_VIDEO_ID` in a browser — you should see `{"ok":true,"total":0,...}`.

> If you change `Code.gs` later, use **Deploy → Manage deployments → Edit → Version: New version** so the URL stays the same.

Each counted view becomes a row in the **Views** tab: time, town, video, anonymous viewer ID, seconds watched, mobile/desktop.

## 4. Publish on GitHub Pages

1. Create a new public repository on GitHub (e.g. `town-views`).
2. Upload all the files in this folder (keep the same structure).
3. Repository **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. After a minute your site is at `https://YOUR-USERNAME.github.io/town-views/`.
   Share that link (not the YouTube link) so views get counted. Results are at `.../stats.html`.

---

## How the counting works

- Every second the page checks: is the video playing **and** is the page on screen? If yes, one second is added.
- Progress is saved on the device, so reloading the page doesn't lose it.
- If the video is shorter than `MIN_SECONDS`, the requirement becomes the full video length minus 2 seconds.
- Once the threshold is reached, the view is sent to the sheet. If the network fails it retries automatically (and again next visit).
- Each device gets a random anonymous ID; the sheet ignores repeat views from the same ID for the same video.

## Limitations to know about

- **Town is self-reported.** Viewers pick their own town. Automatic IP-based location is possible but is often wrong at the town level (mobile data in particular), so it's not used.
- **It's not tamper-proof.** A determined person can clear their browser data or call the endpoint directly to add fake views. It's fine for a community count, not for anything with prizes or money attached.
- **Only views through this site are counted**, not people who watch directly on YouTube. YouTube Studio's own analytics (Audience → Top geographies / cities) shows those, at a coarser level.
- The results page is public to anyone with the link.
