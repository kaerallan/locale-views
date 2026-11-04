// ============================================================
//  Website settings.
//  The video, the town list and the minimum watch time are set in
//  apps-script/Code.gs (on the server) so they can't be tampered with.
// ============================================================
window.TRACKER_CONFIG = {
  // Your Google Apps Script "Web app" URL (ends in /exec). See README.md.
  ENDPOINT_URL: "https://script.google.com/macros/s/AKfycbweGs3uvQ0jY0Tr7sj4koCurG9LH1kPjafiB_tIklrwpg-CSNvQkINFvWFCLZzk_iae/exec",

  // Your Cloudflare Turnstile SITE key (the public one, not the secret). See README.md.
  TURNSTILE_SITE_KEY: "0x4AAAAAAFyzPGbgSQR6K-9j",

  // Page heading.
  TITLE: "Watch our video",
  SUBTITLE: "Tell us where you're watching from — every town counts!",

  // How often the results page refreshes, in seconds.
  STATS_REFRESH_SECONDS: 30,
};
