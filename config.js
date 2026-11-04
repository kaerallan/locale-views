// ============================================================
//  Website settings.
//  The video, the locale list and the minimum watch time are set in
//  apps-script/Code.gs (on the server) so they can't be tampered with.
// ============================================================
window.TRACKER_CONFIG = {
  // Your Google Apps Script "Web app" URL (ends in /exec). See README.md.
  ENDPOINT_URL: "https://script.google.com/macros/s/AKfycbweGs3uvQ0jY0Tr7sj4koCurG9LH1kPjafiB_tIklrwpg-CSNvQkINFvWFCLZzk_iae/exec",

  // Page heading.
  TITLE: "Watch our video",
  SUBTITLE: "Tell us where you're watching from — every locale counts!",

  // How often the results page refreshes, in seconds.
  STATS_REFRESH_SECONDS: 30,
};
