import assert from "node:assert/strict";
import test from "node:test";
import { backgroundHarness, appHarness, deferred, episode, settle } from "./app_harness.mjs";

const ids = (list) => Array.from(list, (entry) => entry.eid);
const add = (h, eid, options = {}) => h.sandbox.updatePlaylist({ action: "add", entry: { eid, pid: "p", title: eid }, ...options });

// Actual background serialization is shared by every extension window/tab.
test("concurrent queue additions survive delayed storage without losing entries", async () => {
  const h = backgroundHarness();
  const firstWrite = deferred(); const originalSet = h.local.set; let writes = 0;
  h.local.set = async (items) => { if (++writes === 1) await firstWrite.promise; return originalSet(items); };
  const a = add(h, "A"), b = add(h, "B"), c = add(h, "C");
  await settle(); assert.equal(writes, 1);
  firstWrite.resolve(); await Promise.all([a, b, c]);
  assert.deepEqual(ids(h.stored.xyzPlaylist), ["A", "B", "C"]);
});

test("queue serialization recovers from storage failure without replacing the old queue", async () => {
  const h = backgroundHarness(); await add(h, "A");
  const originalSet = h.local.set; h.local.set = async () => { throw new Error("disk full"); };
  await assert.rejects(add(h, "B"), /disk full/);
  h.local.set = originalSet; await add(h, "C");
  assert.deepEqual(ids(h.stored.xyzPlaylist), ["A", "C"]);
});

test("queue remove, clear and add are applied in arrival order", async () => {
  const h = backgroundHarness(); await add(h, "A"); await add(h, "B");
  await Promise.all([
    h.sandbox.updatePlaylist({ action: "remove", eid: "A" }),
    h.sandbox.updatePlaylist({ action: "clear" }), add(h, "C")
  ]);
  assert.deepEqual(ids(h.stored.xyzPlaylist), ["C"]);
});

test("drag reorder uses eids after a concurrent removal, and rejects a missing target", async () => {
  const h = backgroundHarness(); for (const id of ["A", "B", "C", "D"]) await add(h, id);
  await Promise.all([
    h.sandbox.updatePlaylist({ action: "remove", eid: "A" }),
    h.sandbox.updatePlaylist({ action: "move", eid: "D", beforeEid: "B" })
  ]);
  assert.deepEqual(ids(h.stored.xyzPlaylist), ["D", "B", "C"]);
  await h.sandbox.updatePlaylist({ action: "move", eid: "B", beforeEid: "missing" });
  assert.deepEqual(ids(h.stored.xyzPlaylist), ["D", "B", "C"]);
});

test("play-next deduplicates and never moves the current item behind its successors", async () => {
  const h = backgroundHarness(); for (const id of ["A", "B", "C"]) await add(h, id);
  await add(h, "A", { currentEid: "A", playNext: true });
  assert.deepEqual(ids(h.stored.xyzPlaylist), ["A", "B", "C"]);
  await add(h, "C", { currentEid: "A", playNext: true });
  await add(h, "C");
  assert.deepEqual(ids(h.stored.xyzPlaylist), ["A", "C", "B"]);
});

test("queue sanitizes corrupted stored data and rejects a podcast-only entry", async () => {
  const h = backgroundHarness(); h.stored.xyzPlaylist = [null, "bad", {}, { eid: "A", pid: "p" }, { eid: "A", pid: "p" }];
  assert.deepEqual(ids(await h.sandbox.handleMessage({ type: "get-playlist" })), ["A"]);
  await assert.rejects(h.sandbox.updatePlaylist({ action: "add", entry: { pid: "p" } }), /无法识别/);
});

test("custom proxy validates HTTPS and requests exactly one origin from the form gesture", async () => {
  const h = appHarness();
  assert.equal(h.run('proxyOrigin("https://proxy.example.org/xyz")'), "https://proxy.example.org/*");
  for (const url of ["http://proxy.example.org", "https://u:p@proxy.example.org", "https://proxy.example.org/?token=secret", "https://proxy.example.org:8443"]) {
    h.sandbox.invalidProxy = url;
    assert.throws(() => h.run("proxyOrigin(invalidProxy)"));
  }
  // Execute the real submit handler with a minimal form snapshot.
  const form = h.document.createElement("form"); form.id = "settings-form";
  form.innerHTML = '<select id="api-mode" value="proxy"></select><input id="proxy-url" value="https://proxy.example.org/base" />';
  h.state.settings = {}; h.sandbox.syncSummaryPromptEditor = () => {};
  const requests = [];
  h.backend.permissions.request = async (request) => { requests.push(request); return false; };
  await h.sandbox.saveSettings({ preventDefault() {}, currentTarget: form });
  assert.deepEqual(Array.from(requests[0].origins), ["https://proxy.example.org/*"]);
  assert.equal(h.calls.some((message) => message.type === "update-settings"), false);
});

test("proxy request checks current permission and refuses redirecting credentials", async () => {
  const h = backgroundHarness();
  await h.sandbox.getSettings();
  h.stored.xyzSettings.apiMode = "proxy"; h.stored.xyzSettings.proxyBaseUrl = "https://proxy.example.org/base";
  h.permissions.contains = async () => false;
  await assert.rejects(h.sandbox.requestJson({ path: "/search", auth: { accessToken: "test" } }), /代理站点未授权/);
  const seen = [];
  h.permissions.contains = async (request) => { seen.push(Array.from(request.origins)); return true; };
  let fetched;
  h.sandbox.fetch = async (url, init) => { fetched = { url: String(url), init }; return { ok: true, status: 200, text: async () => "{}", headers: new Map() }; };
  await h.sandbox.requestJson({ path: "/search", body: {}, auth: { accessToken: "test" } });
  assert.deepEqual(seen, [["https://proxy.example.org/*"]]);
  assert.equal(fetched.url, "https://proxy.example.org/base/search");
  assert.equal(fetched.init.redirect, "error");
});

test("legacy consent does not authorize cloud summary; matching consent permits it", async () => {
  const h = backgroundHarness(); const settings = await h.sandbox.getSettings();
  h.stored.xyzSettings = { ...settings, summaryConsentAccepted: true };
  await assert.rejects(h.sandbox.summarizeTranscript({ transcriptPath: "/transcript.md" }), /重新确认/);
  assert.equal(h.requests.length, 0);
  const scope = h.run("summaryConsentScope")(settings);
  await h.sandbox.updateSettings({ summaryConsentAccepted: true, summaryConsentScope: scope });
  const result = await h.sandbox.summarizeTranscript({ transcriptPath: "/transcript.md" });
  assert.equal(result.markdown, "/summary.md");
  assert.equal(h.requests[0].action, "summarize_transcript");
});

for (const change of [
  { summaryProvider: "deepseek" },
  { summaryProviders: { qwen: { endpoint: "https://other.example.org/chat/completions", model: "qwen-plus" } } },
  { transcriptSource: "asr" },
  { summaryIncludeComments: true }
]) {
  test("changing a recipient or data source invalidates consent: " + Object.keys(change)[0], async () => {
    const h = backgroundHarness(); const settings = await h.sandbox.getSettings();
    await h.sandbox.updateSettings({ summaryConsentAccepted: true, summaryConsentScope: h.run("summaryConsentScope")(settings) });
    const updated = await h.sandbox.updateSettings(change);
    assert.equal(updated.summaryConsentAccepted, false);
    await assert.rejects(h.sandbox.summarizeTranscript({ transcriptPath: "/transcript.md" }), /重新确认/);
    assert.equal(h.requests.length, 0);
  });
}

test("changing ASR endpoint cancels an in-flight summary before audio leaves the device", async () => {
  const h = backgroundHarness(); const settings = await h.sandbox.updateSettings({ transcriptSource: "asr" });
  const scope = h.run("summaryConsentScope")(settings);
  await h.sandbox.updateSettings({ summaryConsentAccepted: true, summaryConsentScope: scope });
  await h.sandbox.updateSettings({ qwenAsrEndpoint: "https://different.example.org/asr" });
  await assert.rejects(h.sandbox.transcribeAudio({ url: "https://media.xyzcdn.net/A.mp3", filename: "A.mp3", consentScope: scope }), /配置已变化/);
  assert.equal(h.requests.length, 0);
});

test("summary refuses the scope of an older task even if a new recipient has been approved", async () => {
  const h = backgroundHarness(); const original = await h.sandbox.getSettings();
  const oldScope = h.run("summaryConsentScope")(original);
  const changed = await h.sandbox.updateSettings({ summaryProvider: "deepseek" });
  await h.sandbox.updateSettings({ summaryConsentAccepted: true, summaryConsentScope: h.run("summaryConsentScope")(changed) });
  await assert.rejects(h.sandbox.summarizeTranscript({ transcriptPath: "/transcript.md", consentScope: oldScope }), /配置已变化/);
  assert.equal(h.requests.length, 0);
});

test("out-of-order QR creations keep only the newest image and one poll timer", async () => {
  const h = appHarness(); const first = deferred(), second = deferred(); let creates = 0;
  h.backend.sandbox.createLoginQrcode = () => ++creates === 1 ? first.promise : second.promise;
  h.sandbox.drawLoginQrcode = (url) => { h.drawn = url; };
  const a = h.sandbox.startLoginQrcode(), b = h.sandbox.startLoginQrcode();
  second.resolve({ id: "new", url: "new-image" }); await b;
  first.resolve({ id: "old", url: "old-image" }); await a;
  assert.equal(h.drawn, "new-image"); assert.equal(h.timers.size, 1);
});

test("closing login while creation is pending prevents late image and polling", async () => {
  const h = appHarness(); const pending = deferred();
  h.backend.sandbox.createLoginQrcode = () => pending.promise;
  h.sandbox.drawLoginQrcode = () => { throw new Error("must not draw"); };
  const creating = h.sandbox.startLoginQrcode(); h.sandbox.stopLoginPolling();
  pending.resolve({ id: "old", url: "old" }); await creating;
  assert.equal(h.timers.size, 0); assert.equal(h.run("openLogin.session"), null);
});

test("stale login poll error cannot stop a refreshed session", async () => {
  const h = appHarness(); const poll = deferred(); let id = 0;
  h.backend.sandbox.createLoginQrcode = async () => ({ id: String(++id), url: "https://example.org/qr" });
  h.backend.sandbox.pollLoginQrcode = () => poll.promise;
  h.sandbox.drawLoginQrcode = () => {};
  await h.sandbox.startLoginQrcode();
  const [timer, tick] = [...h.timers][0]; h.timers.delete(timer);
  const polling = tick(); await h.sandbox.startLoginQrcode();
  const session = h.run("openLogin.session");
  poll.reject(new Error("old poll error")); await polling;
  assert.equal(h.run("openLogin.session"), session);
  assert.equal(h.timers.size, 1);
  assert.equal(h.node("#login-qrcode-status").textContent.includes("old poll error"), false);
});

test("background cancellation rejects late authorization without storing credentials", async () => {
  const h = backgroundHarness(); const poll = deferred();
  h.sandbox.guardedFetch = async () => ({ ok: true, headers: new Map() });
  h.sandbox.readJsonSafe = async () => ({ id: "qr", url: "https://example.org/qr" });
  await h.sandbox.createLoginQrcode();
  h.sandbox.readJsonSafe = () => poll.promise;
  const polling = h.sandbox.pollLoginQrcode({ id: "qr" }); await settle();
  h.sandbox.cancelLoginQrcode();
  poll.resolve({ accessToken: "test-token", status: "AUTHORIZED" });
  assert.equal((await polling).status, "canceled");
  assert.equal(h.stored.xyzAuth, undefined);
});
