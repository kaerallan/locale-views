// Tries to cheat the backend the way an attacker would. Run against the mock:
//   MIN_SECONDS=8 node dev/mock-server.js     (in another terminal)
//   node dev/abuse-test.js
const BASE = process.env.BASE || "http://localhost:8766";
const EXEC = BASE + "/exec";
const post = async body => (await fetch(EXEC, { method: "POST", headers: { "Content-Type": "text/plain" }, body: typeof body === "string" ? body : JSON.stringify(body) })).json();
const rows = async () => (await (await fetch(BASE + "/__rows")).json()).length;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS", name); } else { fail++; console.log("FAIL", name, JSON.stringify(detail)); }
}
const b64 = s => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

(async () => {
  const cfg = await (await fetch(EXEC + "?action=config")).json();
  const MIN = cfg.minSeconds;
  const [A, , C] = cfg.towns;
  const before = await rows();

  // 1. Town not on the list
  let r = await post({ action: "start", town: "Fake Town", device: "attacker01" });
  check("rejects a town not on the list", !r.ok && r.error === "unknown town", r);

  // 3. Finish immediately (skip the watching)
  const s1 = await post({ action: "start", town: A, device: "attacker01" });
  r = await post({ action: "finish", session: s1.session });
  check("rejects finishing before MIN_SECONDS (server clock)", !r.ok && r.error === "too early", r);

  // 4. Forged ticket: change the town inside a real ticket
  const [body, sig] = s1.session.split(".");
  const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  payload.t = C;
  r = await post({ action: "finish", session: b64(JSON.stringify(payload)) + "." + sig });
  check("rejects a ticket edited to another town", !r.ok && r.error === "invalid session", r);

  // 5. Forged ticket: backdate the start time
  payload.t = A; payload.at -= 3600 * 1000;
  r = await post({ action: "finish", session: b64(JSON.stringify(payload)) + "." + sig });
  check("rejects a backdated ticket", !r.ok && r.error === "invalid session", r);

  // 6. Made-up ticket
  r = await post({ action: "finish", session: b64(JSON.stringify({ s: "x", t: A, v: cfg.videoId, d: "attacker01", at: 0 })) + ".AAAA" });
  check("rejects a made-up ticket", !r.ok && r.error === "invalid session", r);

  // 7. Stacking: start several views on one device; only the newest can finish
  const s2 = await post({ action: "start", town: A, device: "attacker02" });
  const s3 = await post({ action: "start", town: A, device: "attacker02" });
  console.log(`   ...waiting ${MIN + 1}s (MIN_SECONDS) for the real-time checks`);
  await sleep((MIN + 1) * 1000);
  r = await post({ action: "finish", session: s2.session });
  check("older view on the same device cannot finish", !r.ok && /replaced/.test(r.error), r);
  r = await post({ action: "finish", session: s3.session });
  check("newest view on the device finishes after MIN_SECONDS", r.ok && !r.duplicate, r);

  // 7b. Same stacking attack, but Google has evicted the cache in between
  const s4 = await post({ action: "start", town: A, device: "attacker03" });
  const s5 = await post({ action: "start", town: A, device: "attacker03" });
  await sleep((MIN + 1) * 1000);
  await fetch(BASE + "/__clearcache");
  const f4 = await post({ action: "finish", session: s4.session });
  const f5 = await post({ action: "finish", session: s5.session });
  check("cache eviction can't let one device count two overlapping views",
    [f4, f5].filter(x => x.ok && !x.duplicate).length === 1, { f4, f5 });

  // 8. Replay the same ticket many times
  const replays = await Promise.all(Array.from({ length: 10 }, () => post({ action: "finish", session: s3.session })));
  check("replaying a finished ticket adds nothing", replays.every(x => x.ok && x.duplicate), replays.find(x => !x.duplicate));

  // 9. Garbage input
  r = await post("not json");
  check("rejects malformed body", !r.ok, r);
  r = await post({ action: "start", town: A, device: "x".repeat(5000) });
  check("rejects oversized request", !r.ok, r);

  // 9b. A device can count again once its previous view is done (a genuine replay)
  const s6 = await post({ action: "start", town: A, device: "attacker03" });
  r = await post({ action: "finish", session: s6.session });
  check("a later replay on the same device is still allowed to start", s6.ok && r.error === "too early", r);

  // 10. Ticket from attacker01 (s1) is still valid if they really waited — that's a legit view
  r = await post({ action: "finish", session: s1.session });
  check("a real, waited-out view from another device counts", r.ok && !r.duplicate, r);

  const added = (await rows()) - before;
  check("exactly 3 views were added in total", added === 3, { added });

  const stats = await (await fetch(EXEC + "?action=stats")).json();
  check("stats never list unknown towns", stats.towns.every(t => cfg.towns.includes(t.town)), stats.towns);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
