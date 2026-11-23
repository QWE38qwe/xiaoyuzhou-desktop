import assert from "node:assert/strict";
import test from "node:test";
import { appHarness, deferred, episode, settle } from "./app_harness.mjs";

async function startFeed(...items) {
  const app = appHarness();
  app.apiHandler = async (endpoint, body) => {
    if (endpoint === "/editor_pick") return { data: items };
    if (endpoint === "/episode_detail") return { data: items.find((item) => item.eid === body.eid) };
    return { data: [] };
  };
  await app.init();
  await settle();
  return app;
}

test("a detail card only browses and the detail timestamp plays its own episode", async () => {
  const app = await startFeed(episode("A"), episode("B"));
  const cards = app.node("#discover-feed").querySelectorAll(".podcast-card");
  await cards[0].querySelector("[data-card-action=play]").click();
  await settle();
  await app.audio.metadata();
  app.audio.currentTime = 52;
  await cards[1].querySelector(".card-copy").click();
  await settle();
  assert.equal(app.node("#route-title").textContent, "B");
  assert.equal(app.node("#player-title").textContent, "A");
  assert.equal(app.node("[data-toggle-current-play]").textContent, "播放");
  assert.equal(app.audio.currentTime, 52);
  assert.equal(app.audio.playCalls, 1);

  await app.node('[data-seek-seconds="30"]').click();
  await settle();
  await app.audio.metadata();
  assert.equal(app.node("#player-title").textContent, "B");
  assert.equal(app.audio.currentTime, 30);
  assert.equal(JSON.parse(app.storage.get("xyzPlaybackPosition:A")), 52);
});

test("stale detail responses and older play intents cannot take over", async () => {
  const older = deferred(), newer = deferred(), afterBack = deferred();
  const items = [episode("A"), episode("B"), episode("C")];
  const app = appHarness();
  app.apiHandler = (endpoint, body) => {
    if (endpoint === "/editor_pick") return { data: items };
    if (endpoint === "/episode_detail") return { A: older, B: newer, C: afterBack }[body.eid].promise;
    return { data: [] };
  };
  await app.init();
  await settle();
  const cards = app.node("#discover-feed").querySelectorAll(".podcast-card");
  await cards[0].querySelector("[data-card-action=play]").click();
  await cards[1].querySelector("[data-card-action=play]").click();
  newer.resolve({ data: items[1] });
  await settle();
  older.resolve({ data: items[0] });
  await settle();
  assert.equal(app.audio.sourceChanges, 1);
  assert.equal(app.node("#player-title").textContent, "B");

  const loadingDetail = cards[2].querySelector(".card-copy").click();
  await settle();
  assert.equal(app.node("#route-title").textContent, "C");
  await app.node("#back-button").click();
  afterBack.resolve({ data: items[2] });
  await loadingDetail;
  assert.equal(app.node("#route-title").textContent, "发现");
  assert.equal(app.node("#player-title").textContent, "B");
});

test("queue ordering, removal, next and auto-advance are local and preserve the route", async () => {
  const app = await startFeed(episode("A"), episode("B"), episode("C"), episode("D"));
  const cards = app.node("#discover-feed").querySelectorAll(".podcast-card");
  await cards[0].querySelector("[data-card-action=play]").click();
  await settle();
  await app.audio.metadata();
  await cards[1].querySelector("[data-card-action=queue]").click();
  await cards[2].querySelector("[data-card-action=queue-next]").click();
  await cards[3].querySelector("[data-card-action=queue]").click();
  await settle();
  const queueIds = () => JSON.parse(app.storage.get("xyzPlaybackQueue")).map((item) => item.eid);
  assert.deepEqual(queueIds(), ["C", "B", "D"]);
  await app.node("#queue-button").click();
  const row = (eid) => app.node(`[data-queue-eid="${eid}"]`);
  await row("B").querySelector('[data-queue-move="-1"]').click();
  await row("D").querySelector("[data-queue-remove]").click();
  assert.deepEqual(queueIds(), ["B", "C"]);
  await app.node("#next-episode-button").click();
  assert.equal(app.node("#player-title").textContent, "B");
  assert.deepEqual(queueIds(), ["C"]);
  await app.audio.metadata();
  await app.audio.finish();
  await settle();
  assert.deepEqual(queueIds(), []);
  assert.equal(app.node("#player-title").textContent, "C");
  assert.equal(app.node("#route-title").textContent, "发现");
  assert.deepEqual([...new Set(app.calls.filter((call) => call.type === "api").map((call) => call.payload.endpoint))], [
    "/editor_pick", "/episode_detail"
  ]);
});

test("positions and queue survive reopening without starting playback", async () => {
  const app = await startFeed(episode("A"), episode("B"));
  const cards = app.node("#discover-feed").querySelectorAll(".podcast-card");
  await cards[0].querySelector("[data-card-action=play]").click();
  await settle();
  await app.audio.metadata();
  app.audio.currentTime = 113;
  await app.windowEvents.emit("pagehide");
  await cards[1].querySelector("[data-card-action=queue]").click();
  await settle();
  const restored = appHarness({ storage: app.storage });
  await restored.init();
  assert.equal(restored.node("#player-title").textContent, "A");
  assert.equal(restored.node("#current-time").textContent, "01:53");
  assert.equal(restored.node("#queue-button").textContent, "队列 (1)");
  assert.equal(restored.audio.sourceChanges, 0);
  await restored.node("#play-button").click();
  await restored.audio.metadata();
  assert.equal(restored.audio.currentTime, 113);
});

test("two open pages keep simultaneous queue entries and remove stale rows by episode ID", async () => {
  const storage = new Map();
  const first = appHarness({ storage });
  const second = appHarness({ storage });
  const items = [episode("A"), episode("B"), episode("C")];
  for (const app of [first, second]) {
    app.apiHandler = async (endpoint, body) => endpoint === "/editor_pick"
      ? { data: items }
      : { data: items.find((item) => item.eid === body.eid) };
  }
  await Promise.all([first.init(), second.init()]);
  await settle();
  const cards = (app) => app.node("#discover-feed").querySelectorAll(".podcast-card");
  const queue = () => JSON.parse(storage.get("xyzPlaybackQueue")).map((item) => item.eid);
  await Promise.all([
    cards(first)[0].querySelector("[data-card-action=queue]").click(),
    cards(second)[1].querySelector("[data-card-action=queue]").click()
  ]);
  await settle();
  assert.deepEqual(queue(), ["A", "B"]);
  const staleRow = first.node('[data-queue-eid="A"]');
  await cards(second)[2].querySelector("[data-card-action=queue-next]").click();
  await settle();
  assert.deepEqual(queue(), ["C", "A", "B"]);
  await staleRow.querySelector("[data-queue-remove]").click();
  assert.deepEqual(queue(), ["C", "B"]);
  await first.node("#next-episode-button").click();
  await first.audio.metadata();
  assert.equal(first.node("#player-title").textContent, "C");
  await first.audio.finish();
  await settle();
  assert.equal(first.node("#player-title").textContent, "B");
  assert.deepEqual(queue(), []);
});

test("subscriptions request one page per action and stop on a repeated cursor", async () => {
  const app = appHarness();
  const first = { type: "PODCAST", pid: "first", title: "First" };
  const second = { type: "PODCAST", pid: "second", title: "Second" };
  const batches = [];
  app.apiHandler = (endpoint, body) => {
    if (endpoint !== "/subscription") return { data: [] };
    batches.push(body);
    return { data: { list: body.loadMoreKey ? [first, second] : [first], loadMoreKey: "page-2" } };
  };
  await app.init();
  await app.node("[data-route=subscriptions]").click();
  await settle();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].loadMoreKey, undefined);
  assert.equal(app.node("#subscriptions-more").hidden, false);
  await app.node("#subscriptions-more").click();
  await settle();
  assert.equal(batches.length, 2);
  assert.equal(batches[1].loadMoreKey, "page-2");
  assert.equal(app.node("#subscriptions-list").querySelectorAll(".podcast-card").length, 2);
  assert.equal(app.node("#subscriptions-more").hidden, true);
});
