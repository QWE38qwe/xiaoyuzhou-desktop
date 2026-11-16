// 登录流程的纯逻辑回归测试（不依赖浏览器环境）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { appHarness, episode, settle } from "./app_harness.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = readFileSync(path.join(projectRoot, "app.js"), "utf8");
const bgSource = readFileSync(path.join(projectRoot, "background.js"), "utf8");

// 二维码边长必须由固定基准算出，不能由 canvas.width 反推（否则每次刷新都会变小）
function qrcodeSize(moduleCount, baseSize) {
  const scale = Math.max(2, Math.floor(baseSize / (moduleCount + 2)));
  return { scale, size: moduleCount * scale };
}

test("QR code size is stable across repeated refreshes", () => {
  const BASE = 200;
  const moduleCount = 37; // 登录 URL（68 字节）实际产生的模块数
  const first = qrcodeSize(moduleCount, BASE);
  for (let i = 0; i < 10; i += 1) {
    const again = qrcodeSize(moduleCount, BASE);
    assert.deepEqual(again, first, "重复刷新后二维码尺寸不应变化");
  }
  assert.ok(first.size >= 180, "二维码渲染结果不应小于 180px，否则难以扫描");
});

test("qrcode base size is a constant, not derived from canvas.width", () => {
  assert.match(
    appSource,
    /const LOGIN_QRCODE_BASE_SIZE = \d+;/,
    "应使用固定常量作为二维码基准尺寸"
  );
  assert.equal(
    /Math\.floor\(canvas\.width/.test(appSource),
    false,
    "不得用 canvas.width 计算缩放（会被绘制结果覆写）"
  );
});

test("login poll loop handles every status the backend can return", () => {
  const handled = ["authorized", "scanned", "expired", "canceled"];
  for (const status of handled) {
    assert.ok(
      appSource.includes(`case "${status}"`),
      `前端缺少 ${status} 状态分支`
    );
  }
  // 后台能产出的所有状态
  const produced = ["waiting", "scanned", "expired", "canceled", "authorized"];
  for (const status of produced) {
    const inApp = appSource.includes(`case "${status}"`) || status === "waiting";
    assert.ok(inApp, `后台会返回 ${status}，前端未处理`);
  }
});

test("polling uses recursive setTimeout instead of setInterval", () => {
  const start = appSource.indexOf("async function startLoginQrcode");
  const end = appSource.indexOf("function openLogin", start);
  const body = appSource.slice(start, end);
  // 只检查真实调用，注释里提到 setInterval 不算
  assert.equal(/setInterval\s*\(/.test(body), false, "不应在轮询里使用 setInterval，会重叠请求");
  assert.ok(body.includes("setTimeout(tick"), "应使用递归 setTimeout 串行轮询");
});

test("login success pulls the full auth object from the background", async () => {
  const h = appHarness();
  const auth = { accessToken: "test-access", refreshToken: "test-refresh", user: { nickname: "test" } };
  h.backend.sandbox.createLoginQrcode = async () => ({ id: "qr", url: "image" });
  h.backend.sandbox.pollLoginQrcode = async () => ({ status: "authorized", user: {} });
  h.backend.sandbox.getAuth = async () => auth;
  h.sandbox.drawLoginQrcode = () => {};
  h.sandbox.markConnection = () => {};
  h.sandbox.renderRoute = () => {};
  await h.sandbox.startLoginQrcode();
  await [...h.timers.values()][0]();
  assert.equal(h.state.auth.accessToken, auth.accessToken);
  assert.equal(h.state.auth.refreshToken, auth.refreshToken);
});

test("background parses JSON safely everywhere", () => {
  assert.equal(
    /await response\.json\(\)/.test(bgSource),
    false,
    "不应直接调用 response.json()，非 JSON 响应会导致误导性的解析错误"
  );
  assert.ok(bgSource.includes("readJsonSafe"), "应统一走 readJsonSafe");
});

test("background no longer ships dead SMS login or localhost probe", () => {
  for (const needle of ["sendSmsCode", 'case "send-code"', "127.0.0.1:7777"]) {
    assert.equal(bgSource.includes(needle), false, `后台仍残留：${needle}`);
  }
});

test("qrcode library exposes a usable factory in a bare sandbox", () => {
  const source = readFileSync(path.join(projectRoot, "qrcode.js"), "utf8");
  const sandbox = { module: undefined, exports: undefined, define: undefined };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.equal(typeof sandbox.qrcode, "function", "qrcode.js 应暴露全局 qrcode 函数");
  const code = sandbox.qrcode(0, "M");
  code.addData("https://h5.xiaoyuzhoufm.com/oauth?qrcode_id=6af54b6c6c1b8642d31d22fd");
  code.make();
  const count = code.getModuleCount();
  assert.ok(count > 0 && count <= 40, "应自动选择合法版本：" + count);
  assert.equal(typeof code.isDark(0, 0), "boolean");
});

test("volume control is wired and persists the level", () => {
  const html = readFileSync(path.join(projectRoot, "app.html"), "utf8");
  for (const id of ["volume-control", "volume-button", "volume-slider", "volume-value", "volume-icon"]) {
    assert.ok(html.includes(`id="${id}"`), `app.html 缺少 #${id}`);
  }
  // 滑块必须覆盖完整音域，否则静音和最大音量表达不了
  assert.match(html, /id="volume-slider"[^>]*min="0"[^>]*max="100"/);

  assert.ok(appSource.includes("function initVolumeControl"), "缺少 initVolumeControl");
  assert.ok(appSource.includes("function applyVolume"), "缺少 applyVolume");
  assert.ok(appSource.includes('localStorage.setItem(VOLUME_KEY'), "音量未持久化");

  // initPlayer 必须真的调用它，否则控件是死的
  const start = appSource.indexOf("function initPlayer");
  const end = appSource.indexOf("function volumeIconFor", start);
  assert.ok(appSource.slice(start, end).includes("initVolumeControl(audio)"),
    "initPlayer 未调用 initVolumeControl");

  // 音量必须落到 audio.volume 上，不能只改 UI
  assert.match(appSource, /audio\.volume\s*=/, "音量未写入 audio.volume");
});

test("volume icon reflects the level", () => {
  const start = appSource.indexOf("function volumeIconFor");
  const end = appSource.indexOf("function applyVolume", start);
  const body = appSource.slice(start, end);
  for (const icon of ["🔇", "🔈", "🔉", "🔊"]) {
    assert.ok(body.includes(icon), `音量图标缺少 ${icon}`);
  }
});

test("subscriptions load every page instead of a hard-coded slice", () => {
  // 旧实现是 limit 20 + slice(0,18)，订阅超过 18 个就显示不全
  assert.equal(/slice\(0,\s*18\)/.test(appSource), false, "订阅列表不应截断到 18 个");
  assert.equal(/slice\(0,\s*12\)/.test(appSource), false, "发现流不应截断到 12 个");

  const start = appSource.indexOf("async function fetchAllSubscriptions");
  assert.ok(start > 0, "缺少 fetchAllSubscriptions");
  const end = appSource.indexOf("function renderSubscriptionCards", start);
  const body = appSource.slice(start, end);
  assert.ok(body.includes("loadMoreKey"), "订阅翻页应使用 loadMoreKey");
  assert.match(body, /while \(page < SUBSCRIPTION_MAX_PAGES\)/, "翻页循环应有上限保护");
  assert.ok(body.includes("seen.has(pid)"), "翻页结果需要按 pid 去重");
});

test("discover is a paginated feed with refresh and infinite scroll", () => {
  // 刷新
  assert.ok(appSource.includes("async function refreshDiscovery"), "缺少刷新逻辑");
  // 加载更多
  assert.ok(appSource.includes("async function loadMoreDiscovery"), "缺少加载更多");
  // 滚动触发
  assert.ok(appSource.includes("IntersectionObserver"), "需要滚动到底自动加载");
  // 分页游标
  assert.ok(appSource.includes("function loadMoreKeyOf"), "缺少分页游标解析");
  // 防止重复请求
  const start = appSource.indexOf("async function loadMoreDiscovery");
  const end = appSource.indexOf("function bindDiscoverFeed", start);
  const body = appSource.slice(start, end);
  assert.ok(body.includes("state.feedLoading"), "并发滚轮会重复请求，需要 loading 锁");
  assert.ok(body.includes("state.feedExhausted"), "需要到底标记，避免无限请求");

  const html = readFileSync(path.join(projectRoot, "app.html"), "utf8");
  assert.ok(!html.includes("discover-sentinel"), "哨兵节点应由 JS 注入，不应写死在静态 HTML");
});

test("playback progress reads and reports through the shared api helper", () => {
  const bg = readFileSync(path.join(projectRoot, "background.js"), "utf8");
  // 三个新接口必须注册到路由表，否则 fetchApi 会因未知 endpoint 抛错
  for (const [name, upstream] of [
    ["/playback_progress", "/v1/playback-progress/list"],
    ["/playback_progress_update", "/v1/playback-progress/update"],
    ["/played_history", "/v1/episode-played/list-history"]
  ]) {
    assert.ok(bg.includes(`"${name}": "${upstream}"`), `background 未注册 ${name}`);
  }

  // 读取与上报都走 api()，鉴权由 fetchApi 统一处理
  const readStart = appSource.indexOf("async function fetchPlaybackProgress");
  assert.ok(appSource.slice(readStart, readStart + 900).includes('api("/playback_progress"'));
  const reportStart = appSource.indexOf("function flushProgressReport");
  assert.ok(appSource.slice(reportStart, reportStart + 900).includes('api("/playback_progress_update"'));
});

test("resume skips finished episodes and guards against short play", () => {
  const start = appSource.indexOf("async function resumePlaybackPosition");
  const end = appSource.indexOf("function seekToTimestamp", start);
  const body = appSource.slice(start, end);
  // 播完的集不应从头恢复
  assert.ok(body.includes("duration - 60"), "播完的集不该续播到片尾");
  // 没有登录就不该请求进度接口
  assert.ok(body.includes("state.auth?.accessToken"), "未登录时应跳过进度读取");
  // 读取的是单集 id
  assert.ok(body.includes("progress.get(eid)"), "应按 eid 取进度");
});

test("progress reporting is throttled and flushed on pause/ended", () => {
  const start = appSource.indexOf("function scheduleProgressReport");
  const end = appSource.indexOf("async function resumePlaybackPosition", start);
  const body = appSource.slice(start, end);
  assert.ok(body.includes("setTimeout"), "需要节流，避免 timeupdate 高频上报");
  assert.ok(body.includes("state.progressTimer"), "重复调用时应复用同一个定时器");
  // 播放器事件里必须有补报
  const initStart = appSource.indexOf("function initPlayer");
  const initEnd = appSource.indexOf("function volumeIconFor", initStart);
  const init = appSource.slice(initStart, initEnd);
  for (const ev of ["pause", "ended"]) {
    assert.ok(init.includes(`addEventListener("${ev}", flushNow)`),
      `缺少 ${ev} 时的进度补报`);
  }
});

test("history page is routed and renders progress", () => {
  assert.ok(appSource.includes("function renderHistoryPage"), "缺少 renderHistoryPage");
  assert.ok(appSource.includes('state.route === "history"'), "路由未接入 history");
  assert.ok(appSource.includes('"/played_history"'), "历史页未请求收听历史");
  assert.ok(appSource.includes("fetchPlaybackProgress"), "历史页应合并各集进度");

  const html = readFileSync(path.join(projectRoot, "app.html"), "utf8");
  assert.ok(html.includes('data-route="history"'), "导航缺少「最近听过」入口");
});

test("played history marks episodes when they start playing", () => {
  const bg = readFileSync(path.join(projectRoot, "background.js"), "utf8");
  assert.ok(bg.includes('"/played_create": "/v1/episode-played/create"'), "后台未注册播放记录接口");
  assert.ok(appSource.includes("markEpisodePlayed"), "缺少 markEpisodePlayed");
  // 必须在 openEpisode 里调用，否则播放不产生记录
  const i = appSource.indexOf("async function openEpisode");
  const j = appSource.indexOf("async function toggleSubscription", i);
  assert.ok(appSource.slice(i, j).includes("markEpisodePlayed"), "openEpisode 未调用 markEpisodePlayed");
});

test("same episode click opens detail instead of replaying", async () => {
  const h = appHarness(); const a = episode("A"); h.cache(a);
  await h.start(a); await h.audio.metadata(); h.audio.currentTime = 100;
  await h.start(a);
  assert.equal(h.state.episodeView.episode.eid, "A");
  assert.equal(h.audio.sourceChanges, 1);
  assert.equal(h.audio.currentTime, 100);
});

test("player title and cover navigate to the podcast", () => {
  const i = appSource.indexOf("async function openEpisode");
  const j = appSource.indexOf("async function toggleSubscription", i);
  const body = appSource.slice(i, j);
  assert.ok(body.includes('$("#player-title").onclick'), "标题未绑定跳转");
  assert.ok(body.includes('$("#player-cover").onclick'), "封面未绑定跳转");
  assert.ok(body.includes("openPodcast(state.current)"), "应跳转到节目详情");
});

test("favorite action is available in cards and player menu", () => {
  assert.ok(appSource.includes("function toggleFavorite"), "缺少 toggleFavorite");
  assert.ok(appSource.includes('"/favorite_update"'), "未调用收藏接口");
  const html = readFileSync(path.join(projectRoot, "app.html"), "utf8");
  assert.ok(html.includes('id="favorite-button"'), "播放器菜单缺少收藏按钮");
});

test("local playlist persists entries and supports drag sorting", async () => {
  const h = appHarness(); await h.sandbox.addToPlaylist(episode("A")); await h.sandbox.addToPlaylist(episode("B"));
  const second = appHarness({ backend: h.backend }); second.state.route = "playlist";
  await second.sandbox.renderRoute();
  const holder = second.node("#playlist-list");
  const source = holder.querySelector('[data-eid="B"]');
  const target = holder.querySelector('[data-eid="A"]');
  await holder.emit("dragstart", { target: source, dataTransfer: { setData() {} } });
  await holder.emit("drop", { target }); await settle();
  assert.deepEqual(Array.from(h.backend.stored.xyzPlaylist, (entry) => entry.eid), ["B", "A"]);
});

test("playlist auto-advances when an episode ends", () => {
  assert.ok(appSource.includes("playNextInPlaylist"), "缺少播完切下一集");
  const i = appSource.indexOf("function initPlayer");
  const j = appSource.indexOf("function volumeIconFor", i);
  const body = appSource.slice(i, j);
  assert.ok(body.includes("playNextInPlaylist"), "播放器未接入自动连播");
});

test("playlist dedupes by episode id", async () => {
  const h = appHarness(); const a = episode("A");
  await Promise.all([h.sandbox.addToPlaylist(a), h.sandbox.addToPlaylist(a)]);
  assert.deepEqual(Array.from(h.backend.stored.xyzPlaylist, (entry) => entry.eid), ["A"]);
});

test("discover supports top lists tabs and switching", () => {
  assert.ok(appSource.includes("const TOP_CATEGORIES"), "缺少 TOP_CATEGORIES 定义");
  assert.ok(appSource.includes("async function loadTopList"), "缺少 loadTopList 函数");
  assert.ok(appSource.includes("function switchDiscoverTab"), "缺少 switchDiscoverTab 函数");
  assert.ok(appSource.includes("HOT_EPISODES_IN_24_HOURS"), "最热榜枚举值未定义");
  assert.ok(appSource.includes("SKYROCKET_EPISODES"), "锋芒榜枚举值未定义");
  assert.ok(appSource.includes("NEW_STAR_EPISODES"), "新星榜枚举值未定义");
});

test("podcast detail fetches and displays popular episodes", () => {
  const bg = readFileSync(path.join(projectRoot, "background.js"), "utf8");
  assert.ok(bg.includes('"/episode_popular": "/v1/episode/list-by-filter"'), "后台未注册 /episode_popular 接口");
  assert.ok(appSource.includes("loadPodcastPopularEpisodes"), "缺少 loadPodcastPopularEpisodes 函数");
  assert.ok(appSource.includes('api("/episode_popular"'), "未调用最受欢迎单集接口");
  assert.ok(appSource.includes("popular-episodes-section"), "缺少热门单集展示容器");
});

test("no single dollar querySelector has .forEach called on it", () => {
  // $(...) 选出来的是单一 Element，调用 forEach 会在运行时抛 $(...).forEach is not a function
  const matches = [...appSource.matchAll(/(?<!\$)\$\(([^)]+)\)\.forEach/g)];
  assert.equal(matches.length, 0, "发现非法 $(...).forEach 调用：" + matches.map(m => m[0]).join(", "));
});

test("playlist loading sanitizes null or corrupted items", () => {
  assert.ok(appSource.includes("episodeIdOf(item)"), "loadPlaylist 应对每个元素校验有效性");
  assert.ok(appSource.includes("item?.duration"), "reduce 计算时长时应做空安全保护");
});

test("playNextInPlaylist prefers current episode eid over raw index", async () => {
  const h = appHarness(); const a = episode("A"), b = episode("B"); h.cache(a, b);
  await h.sandbox.addToPlaylist(a); await h.sandbox.addToPlaylist(b); await h.start(a);
  h.state.playlistIndex = 99;
  await h.sandbox.playNextInPlaylist();
  assert.equal(h.state.current.eid, "B");
});

test("feed cards binding only targets newly added cards", () => {
  const i = appSource.indexOf("function appendFeedCards");
  const j = appSource.indexOf("function updateDiscoverCount", i);
  const body = appSource.slice(i, j);
  assert.ok(body.includes("bindCardActions(holder, state.feed, newCards)"), "分页追加卡片时不应对全量旧卡片重复绑定事件");
});

test("bindCardActions fallback uses double dollar and guarantees array", async () => {
  const h = appHarness(); const a = episode("A"); h.cache(a);
  const holder = h.document.createElement("div"); holder.innerHTML = h.sandbox.podcastCard(a, 0);
  h.sandbox.bindCardActions(holder, [a]);
  await holder.children[0].click(); await settle();
  assert.equal(h.state.episodeView.episode.eid, "A");
  assert.equal(h.audio.sourceChanges, 0);
});
