import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { backgroundHarness } from "./app_harness.mjs";
const root = new URL("../", import.meta.url);
const source = (file) => readFileSync(new URL(file, root), "utf8");
const manifest = JSON.parse(source("manifest.json"));

test("Chrome manifest retains MV3 and Chrome 110 compatibility", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "110");
  assert.equal(manifest.browser_specific_settings, undefined);
});

test("Chrome background is a module service worker", () => {
  assert.equal(manifest.background.service_worker, "background.js");
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.background.scripts, undefined);
});

test("only used permissions are required; arbitrary proxy sites remain optional", () => {
  assert.deepEqual(manifest.permissions, ["storage", "clipboardWrite", "downloads", "nativeMessaging"]);
  assert.equal(manifest.host_permissions.includes("https://*/*"), false);
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self';/);
});

test("Chrome version matches this repair series and exceeds 0.7.2", () => {
  assert.equal(manifest.version, "0.8.5");
});

test("all Chrome runtime files and icons exist", () => {
  for (const file of [manifest.background.service_worker, "app.html", "app.js", "settings_policy.js", ...Object.values(manifest.icons)]) {
    assert.ok(existsSync(new URL(file, root)), file);
  }
  assert.equal(manifest.content_scripts, undefined);
});

test("Chrome message listener keeps the channel alive until the callback response", async () => {
  const h = backgroundHarness(); let listener;
  h.sandbox.chrome.runtime.onMessage.addListener = (value) => { listener = value; };
  // Re-evaluate only the actual registration from the loaded product code.
  const code = source("background.js");
  h.run(code.slice(code.indexOf("chrome.runtime.onMessage.addListener("), code.indexOf("chrome.runtime.onInstalled.addListener(")));
  let response;
  assert.equal(listener({ type: "get-playlist" }, {}, (value) => { response = value; }), true);
  await new Promise(setImmediate);
  assert.equal(response.ok, true);
  assert.deepEqual(Array.from(response.data), []);
  for (const file of ["app.js", "background.js"]) assert.equal(/\bbrowser\./.test(source(file)), false);
});

test("Chrome Native Host installers retain allowed_origins and Chrome paths", () => {
  const sh = source("install_native_host.sh"), ps = source("install_native_host.ps1");
  for (const code of [sh, ps]) {
    assert.match(code, /allowed_origins/);
    assert.equal(code.includes("allowed_extensions"), false);
  }
  assert.match(sh, /Google\/Chrome\/NativeMessagingHosts/);
  assert.match(ps, /Software\\Google\\Chrome\\NativeMessagingHosts/);
  assert.equal(source("background.js").includes("Mozilla/NativeMessagingHosts"), false);
});
