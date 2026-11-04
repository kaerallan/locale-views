// ============================================================
//  EDIT THIS FILE to set up your tracker. Nothing else needs changing.
// ============================================================
window.TRACKER_CONFIG = {
  // The YouTube video ID — the part after "v=" in the link.
  // e.g. https://www.youtube.com/watch?v=dQw4w9WgXcQ  ->  "dQw4w9WgXcQ"
  VIDEO_ID: "dQw4w9WgXcQ",

  // Shown as the page heading.
  TITLE: "Watch our video",
  SUBTITLE: "Tell us where you're watching from — every town counts!",

  // A view only counts after the viewer has actually PLAYED the video
  // for this many seconds (paused, hidden-tab and skipped time don't count).
  // If the video is shorter than this, the whole video (minus 2s) is required.
  MIN_SECONDS: 30,

  // Towns shown in the drop-down. Edit to your list.
  TOWNS: [
    "Town A",
    "Town B",
    "Town C",
  ],

  // Let viewers type a town that isn't in the list.
  ALLOW_OTHER_TOWN: true,

  // Count each device only once for this video.
  ONE_VIEW_PER_DEVICE: true,

  // Paste your Google Apps Script "Web app" URL here (see README.md).
  // Leave empty to run in DEMO MODE: views are saved only in this browser,
  // so you can try the site before connecting the Google Sheet.
  ENDPOINT_URL: "",

  // How often the stats page refreshes, in seconds.
  STATS_REFRESH_SECONDS: 30,
};
