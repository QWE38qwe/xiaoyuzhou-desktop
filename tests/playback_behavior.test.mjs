import assert from "node:assert/strict";
import test from "node:test";
import { appHarness, episode, deferred, settle } from "./app_harness.mjs";

const ids = (list) => Array.from(list, (entry) => entry.eid);
const ready = async (h, item) => { h.cache(item); await h.start(item); await h.audio.metadata(); };

// Each test runs the real app.js, including its DOM listeners and asynchronous callbacks.
test("viewing B through a card preserves A's source, time, playback and chapters", async () => {
  const h = appHarness(); const a = episode("A"), b = episode("B", "01:00 B 的章节");
  h.cache(a, b); await ready(h, a); h.audio.currentTime = 77;
  const holder = h.document.createElement("div");
  holder.innerHTML = h.sandbox.podcastCard(b, 0);
  h.sandbox.bindCardActions(holder, [b]);
  const chapters = h.node("#progress-anchors").innerHTML;
  const plays = h.audio.playCalls;
  await holder.querySelector(".podcast-card").click(); await settle();
  assert.equal(h.state.episodeView.episode.eid, "B");
  assert.equal(h.state.current.eid, "A");
  assert.equal(h.audio.src, a.media.source.url);
  assert.equal(h.audio.currentTime, 77);
  assert.equal(h.audio.paused, false);
  assert.equal(h.audio.playCalls, plays);
  assert.equal(h.node("#progress-anchors").innerHTML, chapters);
  assert.equal(h.played().length, 0);
});

test("A's bottom chapter seeks A while B's detail is visible", async () => {
  const h = appHarness(); const a = episode("A"), b = episode("B");
  h.cache(a, b); await ready(h, a); await h.sandbox.showEpisodeDetail(b);
  await h.node("#progress-anchors").querySelector('[data-progress-seconds="120"]').click(); await settle();
  assert.equal(h.state.current.eid, "A");
  assert.equal(h.state.episodeView.episode.eid, "B");
  assert.equal(h.audio.currentTime, 120);
  assert.equal(h.audio.sourceChanges, 1);
});

for (const initiallyPlaying of [true, false]) {
  test("B's detail timestamp selects B and waits for metadata (existing audio: " + initiallyPlaying + ")", async () => {
    const h = appHarness(); const a = episode("A"), b = episode("B"); h.cache(a, b);
    if (initiallyPlaying) await ready(h, a);
    await h.sandbox.showEpisodeDetail(b);
    await h.node("#page-content").querySelector('[data-seek-seconds="120"]').click(); await settle();
    assert.equal(h.state.current.eid, "B");
    assert.equal(h.audio.currentTime, 0);
    await h.audio.metadata();
    assert.equal(h.audio.currentTime, 120);
    assert.equal(h.state.episodeView.episode.eid, "B");
  });
}

test("playing the same paused episode opens its detail and resumes without reloading", async () => {
  const h = appHarness(); const a = episode("A"), b = episode("B"); h.cache(a, b);
  await ready(h, a); h.audio.currentTime = 90; h.audio.pause();
  await h.sandbox.showEpisodeDetail(b); await h.start(a); await settle();
  assert.equal(h.state.episodeView.episode.eid, "A");
  assert.equal(h.audio.currentTime, 90);
  assert.equal(h.audio.sourceChanges, 1);
  assert.equal(h.audio.paused, false);
});

test("explicit replay and replay after ended both start at zero", async () => {
  const h = appHarness(); const a = episode("A"); await ready(h, a);
  h.audio.currentTime = 300; await h.start(a, { restart: true });
  assert.equal(h.audio.currentTime, 0);
  h.audio.currentTime = 600; h.audio.ended = true; h.audio.paused = true;
  await h.node("#play-button").click(); await settle();
  assert.equal(h.audio.currentTime, 0);
  assert.equal(h.audio.sourceChanges, 1);
});

test("A's play and pause events do not relabel B's detail button", async () => {
  const h = appHarness(); const a = episode("A"), b = episode("B"); h.cache(a, b);
  await ready(h, a); await h.sandbox.showEpisodeDetail(b);
  const button = h.node("[data-toggle-current-play]");
  assert.equal(button.textContent, "播放此单集");
  await h.audio.emit("pause"); await h.audio.emit("play");
  assert.equal(button.textContent, "播放此单集");
});

test("a failed play is not marked heard; successful same-episode retry is marked once", async () => {
  const h = appHarness(); const a = episode("A"); h.cache(a); h.state.auth = { accessToken: "test" };
  h.audio.playResult = async () => { throw new Error("blocked"); };
  await h.start(a); await settle(); assert.equal(h.played().length, 0);
  h.audio.playResult = async () => {};
  await h.node("#play-button").click(); await settle();
  assert.equal(h.played().length, 1);
  await h.start(a); await settle(); assert.equal(h.played().length, 1);
});

test("failed heard-report can be retried and is not held by the success throttle", async () => {
  const h = appHarness(); const a = episode("A"); h.cache(a); h.state.auth = { accessToken: "test" };
  let fail = true;
  h.apiHandler = async (endpoint) => { if (endpoint === "/played_create" && fail) throw new Error("offline"); return { data: [] }; };
  await h.start(a); await settle();
  const first = h.played().length;
  assert.equal(h.state.lastPlayedMark.has("A"), false);
  fail = false; h.audio.pause(); await h.start(a); await settle();
  assert.equal(h.played().length, first + 1);
  assert.equal(h.state.lastPlayedMark.has("A"), true);
});

for (const staleError of [false, true]) {
  test("latest playback request wins over a late " + (staleError ? "error" : "success"), async () => {
    const h = appHarness(); const pending = deferred(); const a = episode("A"), b = episode("B");
    h.cache(b); h.apiHandler = async () => pending.promise;
    const first = h.start(a); await h.start(b);
    if (staleError) pending.reject(new Error("old failure")); else pending.resolve({ data: a });
    await first; await settle();
    assert.equal(h.state.current.eid, "B");
    assert.equal(h.audio.src, b.media.source.url);
    assert.equal(h.node("#toast").textContent.includes("old failure"), false);
  });
}

test("a stale timestamp request cannot seek the newly selected episode", async () => {
  const h = appHarness(); const pending = deferred(); const b = episode("B"), c = episode("C");
  h.cache(c); h.apiHandler = async () => pending.promise;
  const oldSeek = h.seek(b, 200); await h.start(c); await h.audio.metadata();
  h.audio.currentTime = 15; pending.resolve({ data: b }); await oldSeek;
  assert.equal(h.state.current.eid, "C"); assert.equal(h.audio.currentTime, 15);
});

test("browsing a new detail during resolution preserves that detail when playback finishes loading", async () => {
  const h = appHarness(); const pending = deferred(); const a = episode("A"), b = episode("B"); h.cache(b);
  h.apiHandler = async () => pending.promise;
  const play = h.start(a); await h.sandbox.showEpisodeDetail(b);
  pending.resolve({ data: a }); await play;
  assert.equal(h.state.current.eid, "A"); assert.equal(h.state.episodeView.episode.eid, "B");
});

for (const metadataFirst of [true, false]) for (const seconds of [120, 580]) {
  test("resume at " + seconds + " with metadata " + (metadataFirst ? "first" : "last") + " uses the end rule", async () => {
    const h = appHarness(); const a = episode("A"); h.cache(a); h.state.auth = { accessToken: "test" };
    const progress = deferred();
    h.apiHandler = async (endpoint) => endpoint === "/playback_progress" ? progress.promise : {};
    await h.start(a);
    if (metadataFirst) await h.audio.metadata();
    progress.resolve({ data: [{ eid: "A", progress: seconds }] }); await settle();
    if (!metadataFirst) { assert.equal(h.audio.currentTime, 0); await h.audio.metadata(); }
    assert.equal(h.audio.currentTime, seconds === 580 ? 0 : seconds);
  });
}

test("a manual seek cancels saved progress even if the request finishes later", async () => {
  const h = appHarness(); const a = episode("A"); h.cache(a); h.state.auth = { accessToken: "test" };
  const progress = deferred(); h.apiHandler = async (endpoint) => endpoint === "/playback_progress" ? progress.promise : {};
  await h.start(a); await h.audio.metadata();
  h.node("#progress").value = 10; await h.node("#progress").emit("input", { target: h.node("#progress") });
  progress.resolve({ data: [{ eid: "A", progress: 300 }] }); await settle();
  assert.equal(h.audio.currentTime, 60);
});

test("late resume from A cannot overwrite B's explicit chapter", async () => {
  const h = appHarness(); const a = episode("A"), b = episode("B"); h.cache(a, b); h.state.auth = { accessToken: "test" };
  const progress = deferred(); h.apiHandler = async (endpoint) => endpoint === "/playback_progress" ? progress.promise : {};
  await h.start(a); await h.seek(b, 120); await h.audio.metadata();
  progress.resolve({ data: [{ eid: "A", progress: 300 }] }); await settle();
  assert.equal(h.state.current.eid, "B"); assert.equal(h.audio.currentTime, 120);
});

test("old discovery page cannot append to a refresh or unlock the refresh request", async () => {
  const h = appHarness(); h.state.episodeView = null;
  h.node("#page-content").innerHTML = '<div id="discover-feed"></div><div id="discover-sentinel"></div><span id="discover-count"></span>';
  h.state.feed = [episode("A")]; h.state.feedLoadMoreKey = "old";
  const old = deferred(), fresh = deferred();
  h.sandbox.fetchDiscoveryPage = ({ loadMoreKey } = {}) => loadMoreKey ? old.promise : fresh.promise;
  const more = h.sandbox.loadMoreDiscovery(); const refresh = h.sandbox.refreshDiscovery();
  old.resolve({ items: [episode("OLD")], loadMoreKey: "older" }); await more;
  assert.equal(h.state.feedLoading, true); assert.deepEqual(ids(h.state.feed), []);
  fresh.resolve({ items: [episode("NEW")], loadMoreKey: "new" }); await refresh;
  assert.equal(h.state.feedLoading, false); assert.deepEqual(ids(h.state.feed), ["NEW"]);
  assert.equal(h.state.feedLoadMoreKey, "new");
});

test("top lists ignore reversed responses and prohibit curated pagination", async () => {
  const h = appHarness(); h.node("#page-content").innerHTML = '<div id="discover-feed"></div><div id="discover-banner"></div>';
  const hot = deferred(), rock = deferred();
  h.apiHandler = async (_endpoint, body) => body.category === "HOT_EPISODES_IN_24_HOURS" ? hot.promise : rock.promise;
  h.state.feedLoadMoreKey = "curated";
  const first = h.sandbox.loadTopList("hot"), second = h.sandbox.loadTopList("rock");
  rock.resolve({ data: [episode("ROCK")] }); await second;
  hot.resolve({ data: [episode("HOT")] }); await first;
  assert.deepEqual(ids(h.state.feed), ["ROCK"]); assert.equal(h.state.feedLoadMoreKey, "");
});

test("leaving discovery invalidates pending render and locks", async () => {
  const h = appHarness(); h.node("#page-content").innerHTML = '<div id="discover-feed"></div><div id="discover-sentinel"></div>';
  const response = deferred(); h.sandbox.fetchDiscoveryPage = () => response.promise;
  const loading = h.sandbox.refreshDiscovery();
  await h.sandbox.showEpisodeDetail(episode("B"));
  response.resolve({ items: [episode("STALE")], loadMoreKey: "next" }); await loading;
  assert.deepEqual(ids(h.state.feed), []); assert.equal(h.state.feedLoading, false);
  assert.equal(h.state.episodeView.episode.eid, "B");
});

test("iterable card targets and invalid item indices are safe", async () => {
  const h = appHarness(); const holder = h.document.createElement("div");
  holder.innerHTML = '<article class="podcast-card" data-index="99"></article>';
  const cards = new Set(holder.children);
  assert.doesNotThrow(() => h.sandbox.bindCardActions(holder, [], cards));
  await holder.children[0].click(); assert.equal(h.state.episodeView, null);
  assert.doesNotThrow(() => h.sandbox.bindCardActions(holder, [], {}));
});

test("search queue actions resolve a podcast to an episode without starting audio", async () => {
  const h = appHarness(); const b = episode("B"); h.cache(b);
  h.apiHandler = async () => ({ data: [b] });
  const holder = h.document.createElement("div"); const podcast = { type: "PODCAST", pid: "p", title: "Podcast" };
  holder.innerHTML = h.sandbox.searchResultRow(podcast, 0); h.sandbox.bindSearchRows(holder, [podcast]);
  await holder.querySelector('[data-row-action="add-playlist"]').click(); await settle();
  assert.deepEqual(ids(h.backend.stored.xyzPlaylist), ["B"]);
  assert.equal(h.audio.playCalls, 0); assert.equal(h.state.current, null);
});

test("switching audio flushes the old episode's progress under the old eid", async () => {
  const h = appHarness(); const a = episode("A"), b = episode("B"); h.cache(a, b);
  h.state.auth = { accessToken: "test" }; await ready(h, a);
  h.audio.currentTime = 100; await h.audio.emit("timeupdate"); await h.start(b); await settle();
  const updates = h.calls.filter((message) => message.payload?.endpoint === "/playback_progress_update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.body.eid, "A"); assert.equal(updates[0].payload.body.progress, 100);
});

test("late detail response cannot overwrite a different viewed episode", async () => {
  const h = appHarness(); const old = deferred(), b = episode("B"), c = episode("C"); h.cache(c);
  h.apiHandler = () => old.promise;
  const showing = h.sandbox.showEpisodeDetail(b); await h.sandbox.showEpisodeDetail(c);
  old.resolve({ data: b }); await showing;
  assert.equal(h.state.episodeView.episode.eid, "C"); assert.equal(h.audio.sourceChanges, 0);
});

test("podcast progress completing after navigation cannot render into the next view", async () => {
  const h = appHarness(); h.state.auth = { accessToken: "test" };
  const progress = deferred(); const view = { podcast: { pid: "p" }, episodes: null };
  h.state.podcastView = view;
  h.node("#page-content").innerHTML = '<div id="podcast-episodes"></div>';
  const oldHolder = h.node("#podcast-episodes");
  h.apiHandler = async (endpoint) => endpoint === "/playback_progress" ? progress.promise : { data: [episode("A")] };
  const loading = h.sandbox.loadPodcastEpisodes(view); await settle();
  h.state.podcastView = { podcast: { pid: "other" } };
  h.node("#page-content").innerHTML = '<div id="podcast-episodes">new view</div>';
  progress.resolve({ data: [{ eid: "A", progress: 50 }] }); await loading;
  assert.equal(h.node("#podcast-episodes").textContent, "new view");
  assert.equal(oldHolder.children.length, 0);
});

test("removing the current queue item advances to its successor, not the first played item", async () => {
  const h = appHarness(); const a = episode("A"), b = episode("B"), c = episode("C"); h.cache(a, b, c);
  for (const item of [a, b, c]) await h.sandbox.addToPlaylist(item);
  await h.start(b); await h.sandbox.removeFromPlaylist("B");
  await h.sandbox.playNextInPlaylist(); assert.equal(h.state.current.eid, "C");
});

test("sorting and removing entries before the current item preserve the next eid", async () => {
  const h = appHarness(); const items = ["A", "B", "C", "D"].map((id) => episode(id)); h.cache(...items);
  for (const item of items) await h.sandbox.addToPlaylist(item);
  await h.start(items[1]); await h.sandbox.removeFromPlaylist("A");
  await h.sandbox.movePlaylistItem("D", "C"); await h.sandbox.playNextInPlaylist();
  assert.equal(h.state.current.eid, "D");
});

test("clearing the queue leaves playback intact and stops automatic advancement", async () => {
  const h = appHarness(); const a = episode("A"), b = episode("B"); h.cache(a, b);
  await h.sandbox.addToPlaylist(a); await h.sandbox.addToPlaylist(b); await h.start(a);
  await h.sandbox.clearPlaylist(); await h.sandbox.playNextInPlaylist();
  assert.equal(h.state.current.eid, "A"); assert.equal(h.audio.sourceChanges, 1);
});

test("a stale auto-advance read cannot override a newer play command", async () => {
  const h = appHarness(); const a = episode("A"), b = episode("B"); h.cache(a, b);
  await h.start(a); const pending = deferred(); h.sandbox.loadPlaylist = () => pending.promise;
  const advancing = h.sandbox.playNextInPlaylist(); await h.start(b);
  pending.resolve([a, b]); await advancing; assert.equal(h.state.current.eid, "B");
});
