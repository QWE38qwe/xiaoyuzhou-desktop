import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../background.js", import.meta.url), "utf8");

function backgroundHarness() {
  const storage = () => {
    const values = new Map();
    return {
      values,
      get: async (key) => ({ [key]: values.get(key) }),
      set: async (items) => Object.entries(items).forEach(([key, value]) => values.set(key, value)),
      remove: async (key) => values.delete(key)
    };
  };
  const event = () => ({ addListener(listener) { this.listener = listener; } });
  const local = storage();
  const session = storage();
  const alarm = event();
  const requests = [];
  const native = [];
  let now = 10_000;
  const context = vm.createContext({
    URL, console,
    Date: class extends Date { static now() { return now; } },
    crypto: { randomUUID: () => "synthetic-device" },
    chrome: {
      storage: { local, session }, action: { onClicked: event() },
      alarms: { onAlarm: alarm, create() {} },
      windows: { onBoundsChanged: event(), onRemoved: event() },
      runtime: {
        onInstalled: event(), onMessage: event(),
        sendNativeMessage(_host, message, callback) {
          native.push(message);
          callback({ ok: true, data: { markdown: "/summary.md" } });
        }
      }
    },
    async fetch(url, options) {
      requests.push({ url: new URL(url), options });
      const response = new URL(url).pathname === "/v1/auth/login-with-sms"
        ? { data: { user: { nickname: "Fixture", accountId: "fixture-user" }, accessToken: "fixture-token" } }
        : { data: [] };
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => response, text: async () => JSON.stringify(response)
      };
    }
  });
  vm.runInContext(source, context, { filename: "background.js" });
  return { context, local, session, alarm, requests, native, advance: (ms) => { now += ms; } };
}

test("SMS and subscription requests use fixed official hosts even with old proxy settings", async () => {
  const { context, local, session, requests, alarm, advance } = backgroundHarness();
  await local.set({ xyzSettings: { apiMode: "proxy", proxyBaseUrl: "https://proxy.example" } });
  await context.handleMessage({ type: "send-code", payload: { mobilePhoneNumber: "00000000000" } });
  const auth = await context.handleMessage({ type: "login", payload: { mobilePhoneNumber: "00000000000", verifyCode: "000000" } });
  assert.equal(auth.user.nickname, "Fixture");
  assert.equal(auth.user.accountId, undefined);
  assert.equal(auth.accessToken, undefined);
  assert.equal(local.values.has("xyzAuth"), false);
  assert.equal(session.values.has("xyzAuthSession"), true);
  await context.handleMessage({ type: "api", payload: { endpoint: "/subscription" } });
  await assert.rejects(context.requestJson({ path: "@proxy.example/path" }), /未知/);
  assert.deepEqual(requests.map(({ url }) => url.href), [
    "https://podcaster-api.xiaoyuzhoufm.com/v1/auth/send-code",
    "https://podcaster-api.xiaoyuzhoufm.com/v1/auth/login-with-sms",
    "https://api.xiaoyuzhoufm.com/v1/subscription/list"
  ]);
  assert.ok(requests.every(({ options }) => options.redirect === "error"));
  advance(60 * 60 * 1000);
  await alarm.listener({ name: "xyzAuthSession" });
  assert.equal(session.values.has("xyzAuthSession"), false);
});

test("legacy comment settings do not fetch comments or pass them to the summary service", async () => {
  const { context, local, native, requests } = backgroundHarness();
  await local.set({ xyzSettings: { summaryIncludeComments: true } });
  await context.handleMessage({
    type: "summarize-transcript", payload: { transcriptPath: "/transcript.md", episodeId: "episode-a" }
  });
  assert.equal(requests.length, 0);
  assert.equal(native[0].action, "summarize_transcript");
  assert.equal(Object.hasOwn(native[0], "comments"), false);
});
