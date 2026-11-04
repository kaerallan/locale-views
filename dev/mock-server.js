// Local test server: serves the site and runs apps-script/Code.gs against
// in-memory stand-ins for Google's services, so the whole flow can be tested
// without deploying anything.
//
//   node dev/mock-server.js            -> http://localhost:8766
//   MIN_SECONDS=8 node dev/mock-server.js   (shorter threshold for quick tests)
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8766);

// ---------------------------------------------------------------- fake Google services
const props = new Map();
const cacheStore = new Map();
const sheets = new Map();

function makeSheet(name) {
  const rows = [];
  return {
    _rows: rows,
    getName: () => name,
    appendRow: r => rows.push(r.map(v => (typeof v === "string" && v.startsWith("'")) ? v.slice(1) : v)),
    getLastRow: () => rows.length,
    setFrozenRows: () => {},
    getRange: (r, c, nr, nc) => ({
      getValues: () => rows.slice(r - 1, r - 1 + nr).map(row => {
        const out = [];
        for (let i = 0; i < nc; i++) out.push(row[c - 1 + i] === undefined ? "" : row[c - 1 + i]);
        return out;
      }),
    }),
  };
}
const spreadsheet = {
  getId: () => "mock-sheet-id",
  getName: () => "Mock sheet",
  getSheetByName: n => sheets.get(n) || null,
  insertSheet: n => { const s = makeSheet(n); sheets.set(n, s); return s; },
};

const toBuf = v => Buffer.isBuffer(v) ? v : Array.isArray(v) ? Buffer.from(v.map(b => b & 255)) : Buffer.from(String(v), "utf8");
const sandbox = {
  console,
  JSON, Date, Math, Map, Array, Object, String, Number, Error,
  SpreadsheetApp: {
    getActiveSpreadsheet: () => spreadsheet,
    openById: id => { if (id !== "mock-sheet-id") throw new Error("bad id"); return spreadsheet; },
    flush: () => {},
  },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => props.has(k) ? props.get(k) : null,
    setProperty: (k, v) => props.set(k, v),
  }) },
  CacheService: { getScriptCache: () => ({
    get: k => { const e = cacheStore.get(k); if (!e || e.exp < Date.now()) return null; return e.v; },
    put: (k, v, ttl) => {
      if (String(v).length > 100 * 1024) throw new Error("Argument too large");
      cacheStore.set(k, { v: String(v), exp: Date.now() + (ttl || 600) * 1000 });
    },
    remove: k => cacheStore.delete(k),
  }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    base64EncodeWebSafe: v => toBuf(v).toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
    base64DecodeWebSafe: s => [...Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64")].map(b => b > 127 ? b - 256 : b),
    computeHmacSha256Signature: (value, key) =>
      [...crypto.createHmac("sha256", toBuf(key)).update(toBuf(value)).digest()].map(b => b > 127 ? b - 256 : b),
    newBlob: bytes => ({ getDataAsString: () => toBuf(bytes).toString("utf8") }),
  },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: s => ({ content: s, setMimeType() { return this; } }),
  },
};

let code = fs.readFileSync(path.join(ROOT, "apps-script", "Code.gs"), "utf8");
if (process.env.MIN_SECONDS) code = code.replace(/const MIN_SECONDS = \d+;/, "const MIN_SECONDS = " + Number(process.env.MIN_SECONDS) + ";");
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "Code.gs" });
vm.runInContext("setup()", sandbox);

// ---------------------------------------------------------------- HTTP
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/exec") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const parameter = Object.fromEntries(url.searchParams);
      const out = req.method === "POST"
        ? sandbox.doPost({ parameter, postData: { contents: body } })
        : sandbox.doGet({ parameter });
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(out.content);
    });
    return;
  }
  if (url.pathname === "/__clearcache") { // test helper: simulate Google evicting the cache
    cacheStore.clear();
    res.writeHead(200); return res.end("cleared");
  }
  if (url.pathname === "/__rows") { // test helper: what's in the sheet
    const s = sheets.get("Views");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(s ? s._rows : []));
  }
  if (url.pathname === "/config.js") { // point the site at this mock
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(`window.TRACKER_CONFIG = {
      ENDPOINT_URL: "http://localhost:${PORT}/exec",
      TITLE: "Watch our video (LOCAL TEST)",
      SUBTITLE: "Mock backend — nothing here is saved.",
      STATS_REFRESH_SECONDS: 10,
    };`);
  }
  let file = path.normalize(path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log("Mock server on http://localhost:" + PORT));
