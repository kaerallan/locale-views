# Locale Views — YouTube viewers by locale

A static website (hosted on GitHub Pages) that counts **real** views of one YouTube video per town. Works on phones, laptops and desktops.

- Viewers pick their town from a fixed list, then watch the video on the site.
- A view counts only after the video has actually **played** for the minimum time, with the page on screen. Paused time, hidden-tab time and skipping ahead don't count.
- A view is one full stretch of `MIN_SECONDS` of real playback (15 minutes). Any device can earn more views by watching longer or again — one view per completed stretch, never two at once.
- Live totals per town are on the results page.

Views are stored in a Google Sheet you own. A small Google Apps Script checks every view.

| File | What it is |
|---|---|
| `index.html`, `app.js` | Watch page |
| `stats.html`, `stats.js` | Results page |
| `config.js` | Website settings: backend URL, page title |
| `apps-script/Code.gs` | The backend. **The video, town list and minimum seconds are set here.** |
| `dev/` | Local test server and abuse tests (not needed for the live site) |

---

## How views are protected

The browser is never trusted to say "this view counts". The server checks every view:

| An attacker tries to… | What stops it |
|---|---|
| Count a view without watching | The server issues a signed ticket when the view starts and rejects it until `MIN_SECONDS` have passed **on the server's clock**. |
| Add a town, or switch the town later | Towns are checked against the list in `Code.gs`. The town is sealed inside the signed ticket, so editing it breaks the signature. |
| Replay or forge tickets | Tickets are signed with a secret key only the server knows, and each one can be counted only once. |
| Stack many tabs on one device | Starting a view cancels any unfinished view on that device. |

`dev/abuse-test.js` runs all of these attacks against a local copy of the backend.

**What it can't fully stop:** there is no bot check, so someone who writes a script against the backend can still add views — each one still has to wait `MIN_SECONDS` on the server's clock, but many can run in parallel. The same goes for a person playing the video in many browser windows at once. The Sheet logs the time, town and an anonymous device ID for every view, so bursts (many views for one town in a short time, or from one device ID) are easy to spot and delete. No website can confirm that a human is actually looking at the screen.

A Cloudflare Turnstile bot check was tried and removed: it failed for some real visitors (error 600010), which blocked legitimate views.

---

## Setup (about 10 minutes)

### 1. Google Sheet + Apps Script backend

1. Create a new Google Sheet.
2. In the sheet: **Extensions → Apps Script**. Delete what's there, paste in all of `apps-script/Code.gs`.
3. At the top of the script, set:
   - `VIDEO_ID`: the part after `v=` in the YouTube link
   - `MIN_SECONDS`: seconds of watching before a view counts (keep it shorter than the video)
   - `TOWNS`: the fixed list of towns, spelled exactly as they should appear
4. Click **Save**.
5. In the editor, choose the function **`setup`** in the toolbar and click **Run**. Approve the permissions. Google warns the app isn't verified: click *Advanced → Go to project*, since it's your own script.
6. **Deploy → New deployment** → gear → **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Click **Deploy** and copy the **Web app URL** (ends in `/exec`). Put it in `config.js` → `ENDPOINT_URL`.

To check it works, open `YOUR_WEB_APP_URL?action=stats`. You should see your towns, each with `"count":0`.

### 2. Publish

Commit and push `config.js`. GitHub Pages updates in about a minute at https://kaerallan.github.io/town-views/.
Share that link, not the YouTube link. Results are at https://kaerallan.github.io/town-views/stats.html.

### Changing the towns, video or minimum time later

Edit them in the Apps Script editor, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same and the website picks up the change automatically. If you rename a town, views recorded under the old name stop showing (they stay in the Sheet).

---

## Removing suspicious views

Each view is a row in the **Views** tab: time, town, video, session ID, device ID, seconds (measured by the server), mobile/desktop. Delete any rows you don't trust. The results page updates within about 15 seconds.

## Testing locally

Requires Node.js 18+.

```bash
MIN_SECONDS=8 node dev/mock-server.js
```

Open http://localhost:8766. This runs `Code.gs` against an in-memory fake Sheet. In another terminal, run the attack tests:

```bash
node dev/abuse-test.js
```

## Limits

- Apps Script allows about 30 requests at the same moment; each view makes two short requests, so even large bursts of viewers are fine.
- Only views through this site are counted, not people watching directly on YouTube. YouTube Studio's Analytics → Audience shows those at a coarser city level.
- The results page is public to anyone with the link.
