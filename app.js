const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const SIDEBAR_COLLAPSED_KEY = "xyzSidebarCollapsed";
const TOP_CATEGORIES = {
  hot: "HOT_EPISODES_IN_24_HOURS",
  rock: "SKYROCKET_EPISODES",
  new: "NEW_STAR_EPISODES"
};
const TOP_LABELS = {
  curated: "为你精选",
  hot: "最热榜 (24h)",
  rock: "锋芒榜 (飙升)",
  new: "新星榜 (新锐)"
};
// 登录二维码绘制的基准边长；必须固定，不能拿 canvas.width 当基准（会被绘制结果覆写）
const LOGIN_QRCODE_BASE_SIZE = 200;
// 音量设置持久化在 localStorage，跨会话保留
const VOLUME_KEY = "xyzPlayerVolume";
const VOLUME_MUTED_KEY = "xyzPlayerMuted";
const SUMMARY_PROVIDERS = [
  { id: "qwen", label: "Qwen", keyField: "summaryQwenApiKey" },
  { id: "doubao", label: "豆包", keyField: "summaryDoubaoApiKey" },
  { id: "deepseek", label: "DeepSeek", keyField: "summaryDeepseekApiKey" },
  { id: "kimi", label: "Kimi", keyField: "summaryKimiApiKey" },
  { id: "glm", label: "GLM", keyField: "summaryGlmApiKey" }
];

const state = {
  route: "discover",
  searchType: "episode",
  feed: [],
  feedLoadMoreKey: "",
  feedExhausted: false,
  feedLoading: false,
  feedPages: 0,
  feedObserver: null,
  pendingProgress: null,
  progressTimer: null,
  subscriptions: [],
  history: [],
  playlist: [],
  playlistIndex: null,
  discoverTab: "curated",
  topLists: {},
  lastPlayedMark: new Map(),
  current: null,
  episodeDetails: new Map(),
  auth: null,
  settings: null,
  settingsTab: "files",
  searchRequest: 0,
  searchKeyword: "",
  searchResultsByType: { episode: null, podcast: null },
  searchErrorsByType: {},
  podcastView: null,
  episodeView: null,
  subscribedPids: new Set(),
  currentTranscriptPath: "",
  currentTranscriptEpisodeId: "",
  currentTranscriptSegments: [],
  currentSummaryPath: "",
  summaryHistory: new Map(),
  summaryPromptDrafts: [],
  summaryPromptEditorId: ""
};

const routeMeta = {
  discover: ["EXPLORE", "发现"],
  search: ["FIND YOUR NEXT STORY", "搜索"],
  subscriptions: ["YOUR LIBRARY", "我的订阅"],
  history: ["PICK UP WHERE YOU LEFT OFF", "最近听过"],
  playlist: ["YOUR PLAY QUEUE", "播放列表"],
  settings: ["PREFERENCES", "设置"]
};

const SEARCH_TYPES = ["episode", "podcast"];
const SEARCH_TYPE_LABELS = {
  episode: "单集",
  podcast: "节目"
};

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "请求失败"));
      resolve(response.data);
    });
  });
}

function api(endpoint, body = {}, method = "POST") {
  return send("api", { payload: { endpoint, body, method } });
}

function esc(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function summaryRecordOf(item) {
  return state.summaryHistory.get(episodeIdOf(item)) || null;
}

function summaryActionButton(item, className, actionAttribute) {
  const eid = episodeIdOf(item);
  const completed = Boolean(eid && state.summaryHistory.has(eid));
  return `<button
    class="${className}${completed ? " is-complete" : ""}"
    ${actionAttribute}
    ${eid ? `data-summary-eid="${esc(eid)}"` : ""}
    title="${completed ? "已有总结，再次点击可重新生成" : "生成 AI 总结"}"
  >${completed ? "已 AI 总结" : "AI 总结"}</button>`;
}

function transcriptActionLabel(source = state.settings?.transcriptSource) {
  return source === "asr" ? "ASR 转写" : "导出文字稿";
}

function refreshSummaryIndicators(episodeId = "") {
  const eid = String(episodeId || "");
  $$("[data-summary-eid]").forEach((button) => {
    if (button.dataset.summaryEid !== eid) return;
    button.classList.add("is-complete");
    button.textContent = "已 AI 总结";
    button.title = "已有总结，再次点击可重新生成";
  });
  if (episodeIdOf(state.current) === eid) updatePlayerLinkButtons(state.current);
}

function moreActions(content, className = "") {
  if (!content) return "";
  return `<details class="action-menu ${className}">
    <summary class="more-button" title="更多操作" aria-label="更多操作">⋮</summary>
    <div class="action-menu-panel" role="menu">${content}</div>
  </details>`;
}

function closeActionMenu(target) {
  target?.closest(".action-menu")?.removeAttribute("open");
}

// 分页游标：小宇宙用 loadMoreKey（部分接口叫 loadNextKey）标记下一页
function loadMoreKeyOf(response) {
  const data = response?.data ?? response;
  const key = data?.loadMoreKey ?? data?.loadNextKey ?? response?.loadMoreKey ?? response?.loadNextKey;
  return typeof key === "string" && key ? key : "";
}

function dataOf(response) {
  return response?.data ?? response?.list ?? response?.items ?? response ?? [];
}

function itemOf(value) {
  if (["EPISODE", "PODCAST", "USER"].includes(value?.type) || value?.eid || value?.pid) return value;
  return value?.episode || value?.podcast || value?.item || value;
}

function isContentItem(item) {
  return Boolean(item?.eid || item?.pid || item?.episode?.eid || item?.podcast?.pid || item?.podcast?.id ||
    (["EPISODE", "PODCAST"].includes(item?.type) && item?.id));
}

function listOf(response) {
  const data = dataOf(response);
  if (Array.isArray(data)) return data;
  return data?.data ?? data?.list ?? data?.items ?? data?.episodes ?? data?.podcasts ?? data?.picks ?? [];
}

function extractContent(response) {
  const items = [];
  const visited = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) return value.forEach(walk);
    const item = itemOf(value);
    if (item !== value && item && typeof item === "object") {
      if (isContentItem(item)) items.push(item);
      return;
    }
    if (isContentItem(value)) {
      items.push(value);
      return;
    }
    ["data", "list", "items", "picks", "target", "collections", "sections"].forEach((key) => walk(value[key]));
  };
  walk(response);
  return [...new Map(items.map((item) => [`${episodeIdOf(item)}:${podcastIdOf(item)}`, item])).values()];
}

function unwrapDiscovery(response) {
  const collections = listOf(response);
  return collections.flatMap((collection) => {
    if (collection?.type !== "DISCOVERY_COLLECTION") return [collection];
    const sections = Array.isArray(collection?.data) ? collection.data : [collection?.data || collection];
    return sections.flatMap((section) => {
      const targets = section?.target || collection?.target || [];
      return targets.map((target) => target?.episode || target?.podcast || target).filter(Boolean);
    });
  }).filter((item) => item?.type !== "HEADER" && item?.type !== "FOOTER");
}

function unwrapCollectionItems(response) {
  const items = listOf(response);
  return items.flatMap((item) => {
    if (item?.type !== "DISCOVERY_COLLECTION") return [item];
    const sections = Array.isArray(item.data) ? item.data : [item.data || item];
    return sections.flatMap((section) => section?.target || []).map((target) => target?.episode || target?.podcast || target).filter(Boolean);
  }).filter((item) => !["HEADER", "FOOTER"].includes(item?.type));
}

function unwrapDetail(response) {
  const data = dataOf(response);
  return data?.data || data?.episode || data;
}

function imageOf(item) {
  return item?.podcast?.image?.picUrl || item?.podcast?.image?.middlePicUrl || item?.podcast?.cover?.url || item?.podcast?.imageUrl || item?.image?.picUrl || item?.imageUrl || "";
}

function titleOf(item) {
  return item?.title || item?.name || item?.podcast?.title || item?.podcast?.name || "未命名节目";
}

function episodeMetricNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatEpisodeMetricCount(value) {
  const count = episodeMetricNumber(value);
  if (count === null) return "";
  if (count < 10_000) return String(Math.floor(count));
  if (count < 100_000_000) {
    const compact = Math.round(count / 1_000) / 10;
    return `${String(compact).replace(/\.0$/, "")}万`;
  }
  const compact = Math.round(count / 10_000_000) / 10;
  return `${String(compact).replace(/\.0$/, "")}亿`;
}

function formatEpisodePublishDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}.${month}.${day}`;
}

function episodeCardFacts(item) {
  const source = item?.episode?.eid ? item.episode : item;
  const duration = durationOf(source);
  const facts = [
    {
      className: "is-duration",
      label: "时长",
      value: duration ? formatTime(duration) : "",
      icon: ""
    },
    {
      className: "is-published",
      label: "发布日期",
      value: formatEpisodePublishDate(source?.pubDate || source?.publishedAt || source?.createdAt),
      icon: ""
    },
    {
      className: "is-listens",
      label: "收听数",
      value: formatEpisodeMetricCount(source?.playCount),
      icon: "metric-icon-listens"
    },
    {
      className: "is-comments",
      label: "评论数",
      value: formatEpisodeMetricCount(source?.commentCount),
      icon: "metric-icon-comments"
    }
  ].filter((fact) => fact.value);
  if (!facts.length) return "";
  return `<div class="episode-card-facts" aria-label="单集数据">${
    facts.map((fact) => `<span class="episode-card-metric ${fact.className}" aria-label="${esc(`${fact.label} ${fact.value}`)}" title="${esc(`${fact.label} ${fact.value}`)}">${
      fact.icon ? `<i class="metric-icon ${fact.icon}" aria-hidden="true"></i>` : ""
    }<span>${esc(fact.value)}</span></span>`).join("")
  }</div>`;
}

function podcastIdOf(item) {
  return item?.pid || item?.podcast?.pid || item?.podcast?.id || (item?.type === "PODCAST" ? item.id : "") || "";
}

function episodeIdOf(item) {
  return item?.eid || item?.episode?.eid || item?.episode?.id || (item?.type === "EPISODE" ? item.id : "") || "";
}

function podcastOf(item) {
  return item?.podcast && podcastIdOf(item.podcast) ? item.podcast : item;
}

function isPodcastItem(item) {
  return Boolean(podcastIdOf(item) && !episodeIdOf(item));
}

function audioOf(item) {
  return item?.media?.source?.url || item?.media?.url || item?.enclosure?.url || item?.audioUrl || item?.url || "";
}

function episodeContentOf(item) {
  const html = String(item?.shownotes || "");
  if (html) {
    const documentValue = new DOMParser().parseFromString(html, "text/html");
    documentValue.querySelectorAll("[data-timestamp]").forEach((node) => {
      const seconds = Number(node.getAttribute("data-timestamp"));
      const label = Number.isFinite(seconds) ? formatTime(seconds) : "";
      if (label && !String(node.textContent || "").includes(label)) {
        node.prepend(`${label} `);
      }
      node.after(" ");
    });
    documentValue.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
    documentValue.querySelectorAll("p, li, h1, h2, h3, h4")
      .forEach((node) => node.append("\n"));
    const content = String(documentValue.body.textContent || "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (content) return content;
  }
  const plain = item?.description || item?.brief || item?.introduction || "";
  return String(plain).replace(/\\n/g, "\n").trim();
}

function durationOf(item) {
  const value = Number(item?.duration || item?.media?.duration || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function audioExtensionOf(item) {
  try {
    const extension = new URL(audioOf(item)).pathname.match(/\.(mp3|m4a|wav|ogg|flac|aac|aiff|wma|webm)$/i)?.[1];
    return extension ? `.${extension.toLowerCase()}` : ".m4a";
  } catch {
    return ".m4a";
  }
}

function filenamePart(value, fallback) {
  const clean = String(value || fallback).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  return clean || fallback;
}

function audioFilenameOf(item) {
  const extension = audioExtensionOf(item);
  const filename = `${filenamePart(item?.podcast?.title || item?.podcast?.name, "小宇宙")} - ${filenamePart(titleOf(item), "单集")}`;
  return `${filename.slice(0, 160)}${extension}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  return XYZEpisodeContent.formatTimestamp(seconds);
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function setTranscriptionStatus(message = "", type = "pending") {
  const status = $("#transcription-status");
  status.hidden = !message;
  status.textContent = message;
  status.title = message;
  status.style.color = type === "success" ? "#377551" : type === "error" ? "#9a5146" : "#8a6a16";
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const toggle = $("#sidebar-toggle");
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.title = collapsed ? "展开侧栏" : "折叠侧栏";
  toggle.querySelector(".sr-only").textContent = toggle.title;
  toggle.querySelector('[aria-hidden="true"]').textContent = collapsed ? "›" : "‹";
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
}

function setRoute(route) {
  state.podcastView = null;
  state.episodeView = null;
  state.route = route;
  $$(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.route === route));
  const [eyebrow, title] = routeMeta[route];
  $("#route-eyebrow").textContent = eyebrow;
  $("#route-title").textContent = title;
  $("#back-button").hidden = true;
  renderRoute();
}

function markConnection() {
  const node = $("#connection-state");
  node.classList.toggle("is-online", Boolean(state.auth));
  $("#connection-state em").textContent = state.auth ? "已连接" : "未连接";
  const account = $("#account-button");
  const accountName = state.auth?.user?.nickname || state.auth?.user?.name || "";
  account.textContent = state.auth
    ? `${accountName || "已登录"} · 退出`
    : "登录";
  account.classList.toggle("is-logged", Boolean(state.auth));
}

function renderRoute() {
  const root = $("#page-content");
  if (state.episodeView) return renderEpisodePage(root);
  if (state.podcastView) return renderPodcastPage(root);
  if (state.route === "search") return renderSearchPage(root);
  if (state.route === "playlist") return renderPlaylistPage(root);
  if (state.route === "history") return renderHistoryPage(root);
  if (state.route === "subscriptions") return renderSubscriptionsPage(root);
  if (state.route === "settings") return renderSettingsPage(root);
  return renderDiscoverPage(root);
}

function renderDiscoverPage(root) {
  root.innerHTML = `
    <section class="hero">
      <div><div class="route-eyebrow">THE DAILY FREQUENCY</div><h1>今天，听点<br /><span>不一样的。</span></h1><p>从精选节目、热门单集和你可能喜欢的声音里，挑一段刚好适合此刻的陪伴。</p></div>
      <div class="hero-figure" aria-hidden="true"></div>
    </section>
    <div class="section-heading">
      <h2 id="discover-heading-title">为你精选</h2>
      <div class="section-heading-actions">
        <span id="discover-count" class="feed-count"></span>
        <button id="discover-refresh" class="mini-button" type="button" title="重新加载最新节目">刷新</button>
      </div>
    </div>
    <div class="feed-tabs-row" role="tablist" aria-label="发现分类与榜单">
      <button class="feed-tab is-active" data-discover-tab="curated" type="button">为你精选</button>
      <button class="feed-tab" data-discover-tab="hot" type="button">🔥 24h 最热榜</button>
      <button class="feed-tab" data-discover-tab="rock" type="button">⚡ 锋芒榜 · 飙升</button>
      <button class="feed-tab" data-discover-tab="new" type="button">✨ 新星榜 · 新锐</button>
    </div>
    <div id="discover-banner" class="feed-banner-info" hidden></div>
    <div id="discover-feed" class="feed-grid"><div class="loading">正在接收今天的声音……</div></div>
    <div id="discover-sentinel" class="feed-sentinel" aria-hidden="true"></div>`;
  bindDiscoverFeed();
  refreshDiscovery();
}

const DISCOVER_PAGE_SIZE = 18;
const DISCOVER_MAX_PAGES = 30;

function appendFeedCards(holder, items, startIndex) {
  const html = items.map((item, offset) => podcastCard(item, startIndex + offset)).join("");
  holder.insertAdjacentHTML("beforeend", html);
  bindCardActions(holder, state.feed);
}

function updateDiscoverCount() {
  const counter = $("#discover-count");
  if (counter) counter.textContent = `${state.feed.length} 个节目`;
}

function renderFeedStatus(text) {
  const sentinel = $("#discover-sentinel");
  if (!sentinel) return;
  sentinel.innerHTML = text ? `<div class="feed-more">${esc(text)}</div>` : "";
}

// 依次尝试多个发现接口，拿到第一页
async function fetchDiscoveryPage({ loadMoreKey = "" } = {}) {
  const attempts = [
    ["/editor_pick", loadMoreKey ? { loadMoreKey } : {}],
    ["/discovery", loadMoreKey ? { loadMoreKey } : {}],
    ["/top_list", { category: "HOT" }]
  ];
  let lastError;
  for (const [endpoint, body] of attempts) {
    try {
      const response = await api(endpoint, body);
      const items = extractContent(response);
      if (items.length) {
        return { items, loadMoreKey: loadMoreKeyOf(response) };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return { items: [], loadMoreKey: "" };
}

async function loadTopList(tabKey) {
  const holder = $("#discover-feed");
  const banner = $("#discover-banner");
  const sentinel = $("#discover-sentinel");
  if (!holder) return;
  if (sentinel) sentinel.innerHTML = "";
  if (state.feedObserver) {
    state.feedObserver.disconnect();
    state.feedObserver = null;
  }
  const categoryEnum = TOP_CATEGORIES[tabKey];
  if (!categoryEnum) return refreshDiscovery();

  const label = TOP_LABELS[tabKey] || "榜单";
  const titleNode = $("#discover-heading-title");
  if (titleNode) titleNode.textContent = label;

  holder.innerHTML = `<div class="loading">正在加载${esc(label)}……</div>`;
  if (banner) banner.hidden = true;

  try {
    const response = await api("/top_list", { category: categoryEnum }, "GET");
    const rawData = response?.data?.data || response?.data || response;
    const items = extractContent(rawData);
    const info = rawData?.information || rawData?.title || "";

    if (banner && info) {
      banner.textContent = info;
      banner.hidden = false;
    }
    if (!items.length) {
      holder.innerHTML = `<div class="empty">暂时没有获取到${esc(label)}数据。</div>`;
      const counter = $("#discover-count");
      if (counter) counter.textContent = "0 个节目";
      return;
    }
    state.feed = items;
    holder.innerHTML = items.map((item, index) => podcastCard(item, index)).join("");
    bindCardActions(holder, items);
    const counter = $("#discover-count");
    if (counter) counter.textContent = `${items.length} 个节目`;
  } catch (error) {
    holder.innerHTML = `<div class="empty">${esc(error.message)}<br /><button class="mini-button" data-retry-top>重新加载</button></div>`;
    holder.querySelector("[data-retry-top]")?.addEventListener("click", () => loadTopList(tabKey));
  }
}

function switchDiscoverTab(tabKey) {
  state.discoverTab = tabKey;
  $(".feed-tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.discoverTab === tabKey);
  });
  const banner = $("#discover-banner");
  if (banner) banner.hidden = true;
  if (tabKey === "curated") {
    const titleNode = $("#discover-heading-title");
    if (titleNode) titleNode.textContent = "为你精选";
    refreshDiscovery();
  } else {
    loadTopList(tabKey);
  }
}

async function refreshDiscovery() {
  const holder = $("#discover-feed");
  if (!holder) return;
  state.feed = [];
  state.feedLoadMoreKey = "";
  state.feedExhausted = false;
  state.feedLoading = false;
  state.feedPages = 0;
  holder.innerHTML = `<div class="loading">正在接收今天的声音……</div>`;
  renderFeedStatus("");
  try {
    const page = await fetchDiscoveryPage();
    if (!page.items.length) {
      holder.innerHTML = `<div class="empty">暂无发现内容。请确认登录状态或稍后重试。</div>`;
      updateDiscoverCount();
      return;
    }
    holder.innerHTML = "";
    state.feed = page.items;
    state.feedLoadMoreKey = page.loadMoreKey;
    appendFeedCards(holder, page.items, 0);
    updateDiscoverCount();
    // 没有游标就说明这一轮只有一页
    if (!page.loadMoreKey) {
      state.feedExhausted = true;
      renderFeedStatus("");
    } else {
      startFeedObserver();
    }
  } catch (error) {
    holder.innerHTML = `<div class="empty">${esc(error.message)}<br /><button class="mini-button" data-action="login">去登录</button></div>`;
    holder.querySelector("[data-action=login]")?.addEventListener("click", openLogin);
  }
}

async function loadMoreDiscovery() {
  if (state.feedLoading || state.feedExhausted || !state.feedLoadMoreKey) return;
  if (state.feedPages >= DISCOVER_MAX_PAGES) {
    state.feedExhausted = true;
    renderFeedStatus("已经到底了");
    return;
  }
  state.feedLoading = true;
  renderFeedStatus("正在加载更多……");
  try {
    const page = await fetchDiscoveryPage({ loadMoreKey: state.feedLoadMoreKey });
    const holder = $("#discover-feed");
    if (!page.items.length) {
      state.feedExhausted = true;
      renderFeedStatus("已经到底了");
      return;
    }
    // 去重后再追加，避免接口重复返回同一条
    const seen = new Set(state.feed.map((item) => `${episodeIdOf(item)}:${podcastIdOf(item)}`));
    const fresh = page.items.filter((item) => {
      const key = `${episodeIdOf(item)}:${podcastIdOf(item)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) {
      state.feedExhausted = true;
      renderFeedStatus("已经到底了");
      return;
    }
    const startIndex = state.feed.length;
    state.feed = state.feed.concat(fresh);
    state.feedPages = (state.feedPages || 0) + 1;
    appendFeedCards(holder, fresh, startIndex);
    updateDiscoverCount();
    state.feedLoadMoreKey = page.loadMoreKey;
    if (!page.loadMoreKey) {
      state.feedExhausted = true;
      renderFeedStatus("已经到底了");
    } else {
      renderFeedStatus("");
    }
  } catch (error) {
    renderFeedStatus(`加载失败：${error.message}`);
  } finally {
    state.feedLoading = false;
  }
}

function bindDiscoverFeed() {
  $("#discover-refresh")?.addEventListener("click", () => {
    if (state.discoverTab && state.discoverTab !== "curated") {
      loadTopList(state.discoverTab);
    } else {
      refreshDiscovery().catch((error) => notify(error.message));
    }
  });
  $(".feed-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchDiscoverTab(tab.dataset.discoverTab));
  });
}

// 首屏渲染完成后再开始观察哨兵：否则哨兵在空列表时就已可见，
// 会立刻触发一次 loadMore，把两页直接叠在一起。
function startFeedObserver() {
  if (state.feedObserver) {
    state.feedObserver.disconnect();
    state.feedObserver = null;
  }
  const sentinel = $("#discover-sentinel");
  if (!sentinel || typeof IntersectionObserver !== "function") return;
  if (state.feedExhausted || !state.feedLoadMoreKey) return;
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) loadMoreDiscovery();
  }, { rootMargin: "240px" });
  observer.observe(sentinel);
  state.feedObserver = observer;
}

function podcastCard(item, index) {
  const image = imageOf(item);
  const pid = podcastIdOf(item);
  const canViewPodcast = Boolean(pid);
  const subscribed = state.subscribedPids.has(pid);
  const canResolveEpisode = Boolean(episodeIdOf(item) || pid);
  const viewPodcast = canViewPodcast ? `<button class="mini-button" data-card-action="view-podcast">查看节目</button>` : "";
  const summary = canResolveEpisode
    ? summaryActionButton(item, "mini-button is-accent", 'data-card-action="summarize"')
    : "";
  const secondaryActions = [
    canViewPodcast ? `<button data-card-action="subscribe" role="menuitem" ${subscribed ? "disabled" : ""}>${subscribed ? "已订阅" : "订阅节目"}</button>` : "",
    canResolveEpisode ? `<button data-card-action="download" role="menuitem">下载音频</button>` : "",
    canResolveEpisode ? `<button data-card-action="transcribe" role="menuitem">${transcriptActionLabel()}</button>` : "",
    episodeIdOf(item) ? `<button data-card-action="copy-episode" role="menuitem">复制单集链接</button>` : "",
    episodeIdOf(item) ? `<button data-card-action="favorite" role="menuitem">${favoriteActionLabel(item)}</button>` : "",
    episodeIdOf(item) ? `<button data-card-action="play-next" role="menuitem">下一首播放</button>` : "",
    episodeIdOf(item) ? `<button data-card-action="add-playlist" role="menuitem">加入播放列表</button>` : "",
    canViewPodcast ? `<button data-card-action="copy-podcast" role="menuitem">复制节目链接</button>` : ""
  ].join("");
  return `<article class="podcast-card" data-index="${index}">
    <div class="cover">${image ? `<img src="${esc(image)}" alt="" loading="lazy" />` : ""}</div>
    <div class="card-main">
      <div class="card-copy"><strong title="${esc(titleOf(item))}">${esc(titleOf(item))}</strong>${episodeCardFacts(item)}</div>
      <div class="card-actions"><button class="mini-button" data-card-action="play">播放</button>${viewPodcast}${summary}${moreActions(secondaryActions, "action-menu-card")}</div>
    </div>
  </article>`;
}

async function toggleFavorite(item) {
  const eid = episodeIdOf(item);
  if (!eid) return notify("无法识别这个单集");
  if (!state.auth?.accessToken) return notify("请先登录再收藏");
  const favorited = !(state.favorites?.has(eid));
  try {
    await api("/favorite_update", {
      eid,
      favorited,
      sourcePageName: 8,
      currentPageName: 9
    });
    if (!state.favorites) state.favorites = new Set();
    if (favorited) state.favorites.add(eid); else state.favorites.delete(eid);
    notify(favorited ? "已收藏" : "已取消收藏");
    // 刷新当前页面以更新按钮状态
    renderRoute();
  } catch (error) {
    notify("收藏失败：" + error.message);
  }
}

function favoriteActionLabel(item) {
  const eid = episodeIdOf(item);
  return state.favorites?.has(eid) ? "取消收藏" : "收藏单集";
}

function bindCardActions(holder, items) {
  $$(".podcast-card", holder).forEach((card) => {
    card.addEventListener("click", (event) => {
      const item = items[Number(card.dataset.index)];
      const control = event.target.closest("button, summary");
      if (!control) return isPodcastItem(item) ? openPodcast(item) : openEpisode(item);
      if (control.tagName === "SUMMARY") return;
      const action = control.dataset.cardAction;
      closeActionMenu(control);
      if (action === "play") openEpisode(item);
      if (action === "view-podcast") openPodcast(item);
      if (action === "summarize") summarizeEpisode(item, control).catch((error) => notify(error.message));
      if (action === "subscribe") toggleSubscription(item, control);
      if (action === "download") downloadEpisodeAudio(item);
      if (action === "transcribe") exportEpisodeTranscript(item, control);
      if (action === "copy-episode") copyEpisodeLink(item);
      if (action === "copy-podcast") copyPodcastLink(item);
      if (action === "favorite") toggleFavorite(item);
      if (action === "add-playlist") addToPlaylist(item);
      if (action === "play-next") addToPlaylist(item, { playNext: true });
    });
  });
}

function renderSearchPage(root) {
  root.innerHTML = `
    <section><div class="route-eyebrow">SEARCH THE UNIVERSE</div><div class="search-bar"><input id="search-input" type="search" value="${esc(state.searchKeyword)}" placeholder="搜索节目、单集或主播" autocomplete="off" /><button id="search-submit" title="搜索">⌕</button></div>
    <div class="filter-row"><button class="filter-button" data-search-type="episode">单集</button><button class="filter-button" data-search-type="podcast">节目</button></div><div id="search-results" class="result-list"></div></section>`;
  $$("[data-search-type]").forEach((button) => button.classList.toggle("is-active", button.dataset.searchType === state.searchType));
  $$("[data-search-type]").forEach((button) => button.addEventListener("click", () => {
    state.searchType = button.dataset.searchType;
    $$("[data-search-type]").forEach((item) => item.classList.toggle("is-active", item === button));
    renderSearchResults($("#search-results"));
  }));
  $("#search-submit").addEventListener("click", performSearch);
  $("#search-input").addEventListener("keydown", (event) => { if (event.key === "Enter") performSearch(); });
  renderSearchResults($("#search-results"));
}

async function performSearch() {
  const keyword = $("#search-input").value.trim();
  const holder = $("#search-results");
  if (!keyword) return notify("先输入一个关键词");
  state.searchKeyword = keyword;
  state.searchResultsByType = { episode: null, podcast: null };
  state.searchErrorsByType = {};
  const requestId = ++state.searchRequest;
  renderSearchResults(holder, { loading: true });
  const responses = await Promise.allSettled(
    SEARCH_TYPES.map(async (type) => {
      const response = await api("/search", {
        keyword,
        type: type.toUpperCase()
      });
      return {
        type,
        items: listOf(response)
          .map(itemOf)
          .filter((item) => item?.type === type.toUpperCase())
      };
    })
  );
  if (requestId !== state.searchRequest) return;
  responses.forEach((result, index) => {
    const type = SEARCH_TYPES[index];
    if (result.status === "fulfilled") {
      state.searchResultsByType[result.value.type] = result.value.items;
      delete state.searchErrorsByType[result.value.type];
    } else {
      state.searchResultsByType[type] = [];
      state.searchErrorsByType[type] = result.reason?.message || "搜索失败";
    }
  });
  renderSearchResults(holder);
}

function renderSearchResults(holder, { loading = false } = {}) {
  const activeType = state.searchType;
  const label = SEARCH_TYPE_LABELS[activeType] || "内容";
  const results = state.searchResultsByType[activeType];
  const inputValue = $("#search-input")?.value.trim() || state.searchKeyword;
  if (!state.searchKeyword || inputValue !== state.searchKeyword) {
    holder.innerHTML = `<div class="empty">输入关键词，去找到下一段想听的声音。</div>`;
    return;
  }
  if (loading || results === null) {
    holder.innerHTML = `<div class="loading">正在搜索「${esc(state.searchKeyword)}」相关${esc(label)}……</div>`;
    return;
  }
  const error = state.searchErrorsByType[activeType];
  if (error) {
    holder.innerHTML = `<div class="empty">${esc(label)}搜索失败：${esc(error)}<br /><button class="mini-button" data-retry-search>重新搜索</button></div>`;
    holder.querySelector("[data-retry-search]")?.addEventListener("click", performSearch);
    return;
  }
  holder.innerHTML = results.length
    ? results.map((item, index) => searchResultRow(item, index)).join("")
    : `<div class="empty">没有找到和「${esc(state.searchKeyword)}」相关的${esc(label)}。</div>`;
  bindSearchRows(holder, results);
}

function searchResultText(item, isPodcast) {
  return item?.description
    || item?.brief
    || item?.introduction
    || item?.podcast?.title
    || item?.podcast?.name
    || (isPodcast ? "播客节目" : "小宇宙单集");
}

function descriptionBlock(text) {
  const value = String(text || "").trim();
  const collapsible = value.length > 110;
  return `<div class="result-description-wrap${collapsible ? " is-collapsed" : ""}">
    <span class="result-description">${esc(value)}</span>
    ${collapsible ? '<button class="description-toggle" data-row-action="toggle-description" type="button">展开</button>' : ""}
  </div>`;
}

function searchResultRow(item, index) {
  const isPodcast = isPodcastItem(item);
  const pid = podcastIdOf(item);
  const canViewPodcast = Boolean(pid);
  const subscribed = state.subscribedPids.has(pid);
  const canResolveEpisode = item?.type !== "USER" && Boolean(episodeIdOf(item) || pid);
  const secondaryActions = item?.type === "USER" ? "" : [
    isPodcast ? `<button data-row-action="subscribe" role="menuitem" ${subscribed ? "disabled" : ""}>${subscribed ? "已订阅" : "订阅节目"}</button>` : "",
    canResolveEpisode ? `<button data-row-action="play-next" role="menuitem">下一首播放</button>` : "",
    canResolveEpisode ? `<button data-row-action="add-playlist" role="menuitem">加入播放列表</button>` : "",
    canResolveEpisode ? `<button data-row-action="download" role="menuitem">下载音频</button>` : "",
    canResolveEpisode ? `<button data-row-action="transcribe" role="menuitem">${transcriptActionLabel()}</button>` : "",
    episodeIdOf(item) ? `<button data-row-action="copy-episode" role="menuitem">复制单集链接</button>` : "",
    canViewPodcast ? `<button data-row-action="copy-podcast" role="menuitem">复制节目链接</button>` : ""
  ].join("");
  const actions = item?.type === "USER" ? "" : `
    <button class="row-action" data-row-action="play">播放</button>
    <button class="row-action" data-row-action="view-podcast" ${canViewPodcast ? "" : "disabled"}>查看节目</button>
    ${summaryActionButton(item, "row-action is-primary", 'data-row-action="summarize"')}
    ${moreActions(secondaryActions, "action-menu-row")}`;
  return `<article class="episode-row" data-index="${index}">
    <div class="episode-thumb">${imageOf(item) ? `<img src="${esc(imageOf(item))}" alt="" />` : ""}</div>
    <div class="episode-meta"><strong>${esc(titleOf(item))}</strong>${descriptionBlock(searchResultText(item, isPodcast))}</div>
    <div class="row-actions">${actions}</div>
  </article>`;
}

function bindSearchRows(holder, items) {
  $$(".episode-row", holder).forEach((row) => row.addEventListener("click", (event) => {
    const item = items[Number(row.dataset.index)];
    const control = event.target.closest("button, summary");
    if (!control) {
      if (isPodcastItem(item)) openPodcast(item);
      else if (episodeIdOf(item)) openEpisode(item);
      return;
    }
    if (control.tagName === "SUMMARY") return;
    const action = control.dataset.rowAction;
    closeActionMenu(control);
    if (action === "toggle-description") {
      const wrapper = control.closest(".result-description-wrap");
      wrapper?.classList.toggle("is-collapsed");
      control.textContent = wrapper?.classList.contains("is-collapsed") ? "展开" : "收起";
      return;
    }
    if (action === "play") openEpisode(item);
    if (action === "view-podcast") openPodcast(item);
    if (action === "summarize") summarizeEpisode(item, control).catch((error) => notify(error.message));
    if (action === "subscribe") toggleSubscription(item, control);
    if (action === "download") downloadEpisodeAudio(item);
    if (action === "transcribe") exportEpisodeTranscript(item, control);
    if (action === "copy-episode") copyEpisodeLink(item);
    if (action === "copy-podcast") copyPodcastLink(item);
  }));
}

function renderSubscriptionsPage(root) {
  root.innerHTML = `<section><div class="section-heading">
      <h2>我的订阅</h2>
      <div class="section-heading-actions">
        <span id="subscriptions-count" class="feed-count"></span>
        <span>YOUR SUBSCRIPTIONS</span>
      </div>
    </div><div id="subscriptions-list" class="feed-grid"><div class="loading">正在读取你的订阅……</div></div></section>`;
  loadSubscriptions();
}

const SUBSCRIPTION_PAGE_SIZE = 50;
// 单次加载的硬性上限，防止接口异常时无限翻页
const SUBSCRIPTION_MAX_PAGES = 40;

const HISTORY_PAGE_SIZE = 24;

function historyProgressLabel(record) {
  const seconds = Number(record?.progress ?? record?.playedSeconds ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return `上次听到 ${formatTime(seconds)}`;
}

async function loadHistory() {
  const holder = $("#history-list");
  if (!holder) return;
  try {
    const body = {};
    const response = await api("/played_history", body);
    const items = extractContent(response).filter((item) => episodeIdOf(item));
    state.history = items;
    // 把各集进度合并进来，用于显示「上次听到 X」
    const progress = await fetchPlaybackProgress(items.map((item) => episodeIdOf(item)));
    holder.innerHTML = items.length
      ? items.map((item, index) => {
        const card = podcastCard(item, index);
        const seconds = progress.get(episodeIdOf(item))?.seconds;
        const label = Number.isFinite(seconds) && seconds > 0
          ? `<span class="history-progress">上次听到 ${esc(formatTime(seconds))}</span>`
          : "";
        return card.replace("</article>", label + "</article>");
      }).join("")
      : `<div class="empty">还没有收听记录。去发现页找一集听听吧。</div>`;
    bindCardActions(holder, items);
  } catch (error) {
    holder.innerHTML = `<div class="empty">${esc(error.message)}<br /><button class="mini-button" data-action="login">去登录</button></div>`;
    holder.querySelector("[data-action=login]")?.addEventListener("click", openLogin);
  }
}

function renderHistoryPage(root) {
  root.innerHTML = `<section>
    <div class="section-heading"><h2>最近听过</h2><span>RECENTLY PLAYED</span></div>
    <div id="history-list" class="feed-grid"><div class="loading">正在读取你的收听记录……</div></div>
  </section>`;
  loadHistory();
}

async function renderPlaylistPage(root) {
  root.innerHTML = `<section>
    <div class="section-heading">
      <h2>播放列表</h2>
      <div class="section-heading-actions">
        <span id="playlist-count" class="feed-count"></span>
        <button id="playlist-play-all" class="mini-button is-accent" type="button" title="从第一首开始连续播放">全部播放</button>
        <button id="playlist-clear" class="mini-button" type="button" title="清空全部待播单集">清空列表</button>
      </div>
    </div>
    <div id="playlist-list" class="playlist-list"><div class="loading">正在读取播放列表……</div></div>
  </section>`;
  const holder = $("#playlist-list");
  const list = await loadPlaylist();
  state.playlist = list;
  const counter = $("#playlist-count");
  const currentEid = episodeIdOf(state.current);
  if (counter) {
    const totalSecs = list.reduce((sum, item) => sum + (Number(item.duration) || 0), 0);
    const timeStr = totalSecs > 0 ? ` · 约 ${Math.round(totalSecs / 60)} 分钟` : "";
    counter.textContent = `${list.length} 集${timeStr}`;
  }
  if (!list.length) {
    holder.innerHTML = `<div class="empty">播放列表为空。在单集卡片或播放页点击「加入播放列表」即可添加，单集播完将自动按顺序连播下一集。</div>`;
    $("#playlist-play-all")?.setAttribute("disabled", "true");
    $("#playlist-clear")?.setAttribute("disabled", "true");
    return;
  }
  holder.innerHTML = list.map((entry, index) => {
    const isPlaying = currentEid && entry.eid === currentEid;
    return `
    <div class="playlist-item${isPlaying ? " is-current" : ""}" data-index="${index}" data-eid="${esc(entry.eid)}" draggable="true">
      <div class="drag-handle" title="按住拖拽调整顺序" aria-label="拖动排序">⋮⋮</div>
      <div class="playlist-item-index">${isPlaying ? "▶" : index + 1}</div>
      <div class="playlist-item-cover">${entry.image ? `<img src="${esc(entry.image)}" alt="" />` : "<span>◌</span>"}</div>
      <div class="playlist-item-copy">
        <strong title="${esc(entry.title)}">${esc(entry.title)}</strong>
        <span>${esc(entry.podcastTitle)}${entry.duration ? ` · ${formatTime(entry.duration)}` : ""}${isPlaying ? " (正在播放)" : ""}</span>
      </div>
      <div class="playlist-item-actions">
        <button class="mini-button${isPlaying ? " is-accent" : ""}" data-playlist-action="play" data-index="${index}">${isPlaying ? "重播" : "播放"}</button>
        <button class="mini-button" data-playlist-action="remove" data-eid="${esc(entry.eid)}" title="移出列表">移除</button>
      </div>
    </div>`;
  }).join("");

  $("#playlist-play-all")?.addEventListener("click", () => playAllPlaylist());
  $("#playlist-clear")?.addEventListener("click", () => clearPlaylist());

  // 原生拖拽排序
  let dragIndex = null;
  holder.addEventListener("dragstart", (event) => {
    const item = event.target.closest(".playlist-item");
    if (!item) return;
    dragIndex = Number(item.dataset.index);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(dragIndex));
    item.classList.add("is-dragging");
  });
  holder.addEventListener("dragover", (event) => {
    event.preventDefault();
    const item = event.target.closest(".playlist-item");
    if (!item) return;
    item.classList.add("is-drop-target");
  });
  holder.addEventListener("dragleave", (event) => {
    event.target.closest(".playlist-item")?.classList.remove("is-drop-target");
  });
  holder.addEventListener("dragend", (event) => {
    event.target.closest(".playlist-item")?.classList.remove("is-dragging");
    $(".playlist-item.is-drop-target", holder).forEach(el => el.classList.remove("is-drop-target"));
  });
  holder.addEventListener("drop", (event) => {
    event.preventDefault();
    const item = event.target.closest(".playlist-item");
    $(".playlist-item.is-drop-target", holder).forEach(el => el.classList.remove("is-drop-target"));
    if (!item || dragIndex == null) return;
    const toIndex = Number(item.dataset.index);
    if (dragIndex !== toIndex) {
      movePlaylistItem(dragIndex, toIndex);
    }
    dragIndex = null;
  });
  holder.addEventListener("click", (event) => {
    const button = event.target.closest("[data-playlist-action]");
    if (!button) return;
    if (button.dataset.playlistAction === "play") playPlaylistAt(Number(button.dataset.index));
    if (button.dataset.playlistAction === "remove") removeFromPlaylist(button.dataset.eid);
  });
}

async function fetchAllSubscriptions() {
  const collected = [];
  const seen = new Set();
  let loadMoreKey = "";
  let page = 0;
  while (page < SUBSCRIPTION_MAX_PAGES) {
    const body = { limit: String(SUBSCRIPTION_PAGE_SIZE), sortOrder: "desc", sortBy: "subscribedAt" };
    if (loadMoreKey) body.loadMoreKey = loadMoreKey;
    const response = await api("/subscription", body);
    const pageItems = listOf(response).map(itemOf).filter((item) => item?.type === "PODCAST");
    for (const item of pageItems) {
      const pid = podcastIdOf(item);
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      collected.push(item);
    }
    // 没有游标说明已经到底；返回空页也视为到底，避免死循环
    const next = loadMoreKeyOf(response);
    if (!next || next === loadMoreKey || !pageItems.length) break;
    loadMoreKey = next;
    page += 1;
  }
  return collected;
}

function renderSubscriptionCards(holder, items) {
  holder.innerHTML = items.length
    ? items.map((item, index) => podcastCard(item, index)).join("")
    : `<div class="empty">还没有订阅节目。去发现页逛逛吧。</div>`;
  bindCardActions(holder, items);
}

async function loadSubscriptions() {
  const holder = $("#subscriptions-list");
  try {
    state.subscriptions = await fetchAllSubscriptions();
    state.subscriptions.forEach((item) => state.subscribedPids.add(podcastIdOf(item)));
    renderSubscriptionCards(holder, state.subscriptions);
    const counter = $("#subscriptions-count");
    if (counter) counter.textContent = `${state.subscriptions.length} 个节目`;
  } catch (error) {
    holder.innerHTML = `<div class="empty">${esc(error.message)}<br /><button class="mini-button" data-action="login">去登录</button></div>`;
    holder.querySelector("[data-action=login]")?.addEventListener("click", openLogin);
  }
}

function openPodcast(item) {
  const podcast = podcastOf(item);
  const pid = podcastIdOf(podcast);
  if (!pid) return notify("无法识别这个节目");
  state.episodeView = null;
  state.podcastView = {
    podcast,
    episodes: null,
    sourceRoute: state.route,
    scrollY: window.scrollY
  };
  $("#route-eyebrow").textContent = "PROGRAM ARCHIVE";
  $("#route-title").textContent = titleOf(podcast);
  $("#back-button").hidden = false;
  renderRoute();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function closePodcast() {
  if (!state.podcastView) return;
  const { sourceRoute, scrollY } = state.podcastView;
  state.podcastView = null;
  state.route = sourceRoute;
  const [eyebrow, title] = routeMeta[sourceRoute];
  $("#route-eyebrow").textContent = eyebrow;
  $("#route-title").textContent = title;
  $("#back-button").hidden = true;
  renderRoute();
  requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
}

function closeEpisode() {
  if (!state.episodeView) return;
  const { scrollY } = state.episodeView;
  state.episodeView = null;
  if (state.podcastView) {
    $("#route-eyebrow").textContent = "PROGRAM ARCHIVE";
    $("#route-title").textContent = titleOf(state.podcastView.podcast);
    $("#back-button").hidden = false;
  } else {
    const [eyebrow, title] = routeMeta[state.route];
    $("#route-eyebrow").textContent = eyebrow;
    $("#route-title").textContent = title;
    $("#back-button").hidden = true;
  }
  renderRoute();
  requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "auto" }));
}

function timestampDeepLink(item, seconds) {
  return XYZEpisodeContent.deepLink(episodeIdOf(item), seconds);
}

// 进度上报节流：播放器 timeupdate 触发太频繁，最多每 12 秒上报一次
const PROGRESS_REPORT_INTERVAL_MS = 12_000;
// 播放不足 5 秒不写入，避免误点产生一堆垃圾记录
const MIN_PLAY_PROGRESS_SECONDS = 5;

// 标记为听过：调用 /v1/episode-played/create，这会把单集加入「最近听过」
// 进度上报（playback-progress/update）只写进度，不产生收听历史记录
async function markEpisodePlayed(item) {
  const eid = episodeIdOf(item);
  if (!eid || !state.auth?.accessToken) return;
  const pid = podcastIdOf(item);
  // 同一集短时间内不重复上报
  const now = Date.now();
  const last = state.lastPlayedMark?.get(eid) || 0;
  if (now - last < 30_000) return;
  if (!state.lastPlayedMark) state.lastPlayedMark = new Map();
  state.lastPlayedMark.set(eid, now);
  api("/played_create", { eid, pid }).catch(() => {
    // 上报失败不影响播放
  });
}

// 本地播放列表：存在扩展本地存储，支持添加单集、排序、顺序播放
const PLAYLIST_KEY = "xyzPlaylist";

function updatePlaylistBadges(count) {
  const num = Math.max(0, Number(count) || 0);
  const navBadge = $("#nav-playlist-badge");
  if (navBadge) {
    navBadge.textContent = String(num);
    navBadge.hidden = num === 0;
  }
  const queueBadge = $("#player-queue-badge");
  if (queueBadge) {
    queueBadge.textContent = String(num);
    queueBadge.hidden = num === 0;
  }
}

async function loadPlaylist() {
  try {
    const { [PLAYLIST_KEY]: list = [] } = await chrome.storage.local.get(PLAYLIST_KEY);
    const valid = Array.isArray(list) ? list : [];
    state.playlist = valid;
    updatePlaylistBadges(valid.length);
    return valid;
  } catch {
    return [];
  }
}

async function savePlaylist(list) {
  const valid = Array.isArray(list) ? list : [];
  await chrome.storage.local.set({ [PLAYLIST_KEY]: valid });
  state.playlist = valid;
  updatePlaylistBadges(valid.length);
}

async function addToPlaylist(item, { playNext = false, notifyUser = true } = {}) {
  const eid = episodeIdOf(item);
  const pid = podcastIdOf(item);
  if (!eid || !pid) return notify("无法识别这个单集");
  const list = await loadPlaylist();
  const existingIndex = list.findIndex((entry) => episodeIdOf(entry) === eid);

  const entry = {
    eid,
    pid,
    title: titleOf(item),
    podcastTitle: item?.podcast?.title || item?.podcast?.name || "",
    duration: durationOf(item) || 0,
    image: imageOf(item) || "",
    addedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    if (playNext) {
      list.splice(existingIndex, 1);
      const currentEid = episodeIdOf(state.current);
      const curIdx = currentEid ? list.findIndex((e) => episodeIdOf(e) === currentEid) : -1;
      const targetIdx = curIdx >= 0 ? curIdx + 1 : 0;
      list.splice(targetIdx, 0, entry);
      await savePlaylist(list);
      if (notifyUser) notify("已移至下一首播放");
    } else {
      if (notifyUser) notify("已在播放列表中");
    }
  } else {
    if (playNext) {
      const currentEid = episodeIdOf(state.current);
      const curIdx = currentEid ? list.findIndex((e) => episodeIdOf(e) === currentEid) : -1;
      const targetIdx = curIdx >= 0 ? curIdx + 1 : 0;
      list.splice(targetIdx, 0, entry);
      await savePlaylist(list);
      if (notifyUser) notify("已设为下一首播放");
    } else {
      list.push(entry);
      await savePlaylist(list);
      if (notifyUser) notify(`已加入播放列表（共 ${list.length} 集）`);
    }
  }
  if (state.route === "playlist") renderRoute();
}

async function removeFromPlaylist(eid) {
  const list = (await loadPlaylist()).filter((entry) => episodeIdOf(entry) !== eid);
  await savePlaylist(list);
  notify("已从播放列表移除");
  if (state.route === "playlist") renderRoute();
}

async function clearPlaylist() {
  await savePlaylist([]);
  notify("已清空播放列表");
  if (state.route === "playlist") renderRoute();
}

async function movePlaylistItem(fromIndex, toIndex) {
  const list = await loadPlaylist();
  if (fromIndex < 0 || fromIndex >= list.length) return;
  if (toIndex < 0 || toIndex >= list.length) return;
  const [moved] = list.splice(fromIndex, 1);
  list.splice(toIndex, 0, moved);
  await savePlaylist(list);
  notify("播放顺序已调整");
  if (state.route === "playlist") renderRoute();
}

async function playPlaylistAt(index) {
  const list = await loadPlaylist();
  const entry = list[index];
  if (!entry) return notify("选中的单集不在列表中");
  const item = {
    type: "EPISODE",
    eid: entry.eid,
    pid: entry.pid,
    title: entry.title,
    podcast: { pid: entry.pid, title: entry.podcastTitle },
    duration: entry.duration,
    image: { picUrl: entry.image },
    media: { source: { url: "" } }
  };
  state.playlistIndex = index;
  await openEpisode(item);
}

async function playAllPlaylist() {
  const list = await loadPlaylist();
  if (!list.length) return notify("播放列表为空");
  await playPlaylistAt(0);
}

async function playNextInPlaylist() {
  const list = await loadPlaylist();
  if (!list.length) return;
  let next = 0;
  if (state.playlistIndex != null) {
    next = state.playlistIndex + 1;
  } else if (state.current) {
    const curEid = episodeIdOf(state.current);
    const idx = list.findIndex(e => episodeIdOf(e) === curEid);
    next = idx >= 0 ? idx + 1 : 0;
  }
  if (next >= list.length) {
    state.playlistIndex = null;
    return notify("播放列表已全部播完");
  }
  const nextEntry = list[next];
  notify(`正在自动连播下一首：${nextEntry.title}`);
  await playPlaylistAt(next);
}

function progressListOf(response) {
  const data = response?.data ?? response;
  if (Array.isArray(data)) return data;
  return data?.list ?? data?.items ?? data?.data ?? [];
}

async function fetchPlaybackProgress(eids) {
  const ids = (Array.isArray(eids) ? eids : [eids]).filter(Boolean);
  if (!ids.length) return new Map();
  if (!state.auth?.accessToken) return new Map();
  try {
    const response = await api("/playback_progress", { eids: ids });
    const map = new Map();
    for (const record of progressListOf(response)) {
      const eid = record?.eid || record?.id;
      const seconds = Number(record?.progress);
      if (eid && Number.isFinite(seconds) && seconds > 0) {
        map.set(eid, { seconds, playedAt: record.playedAt || "", pid: record.pid || "" });
      }
    }
    return map;
  } catch {
    // 进度读取失败不应阻断播放
    return new Map();
  }
}

function flushProgressReport() {
  const pending = state.pendingProgress;
  state.pendingProgress = null;
  if (!pending) return;
  if (!state.auth?.accessToken) return;
  if (pending.seconds < MIN_PLAY_PROGRESS_SECONDS) return;
  api("/playback_progress_update", {
    eid: pending.eid,
    pid: pending.pid,
    progress: pending.seconds,
    playedAt: new Date().toISOString()
  }).catch(() => {
    // 上报失败不影响继续播放
  });
}

function scheduleProgressReport(item, seconds) {
  if (!state.auth?.accessToken) return;
  const eid = episodeIdOf(item);
  const pid = podcastIdOf(item);
  if (!eid || !pid) return;
  state.pendingProgress = { eid, pid, seconds };
  if (state.progressTimer) return;
  state.progressTimer = setTimeout(() => {
    state.progressTimer = null;
    flushProgressReport();
  }, PROGRESS_REPORT_INTERVAL_MS);
}

async function resumePlaybackPosition(episode, player) {
  const eid = episodeIdOf(episode);
  if (!eid || !state.auth?.accessToken) return null;
  const progress = await fetchPlaybackProgress(eid);
  const record = progress.get(eid);
  if (!record) return null;
  const duration = Number(player.duration);
  const target = Number(record.seconds);
  // 若上次已经播完（距结尾不足 60 秒）则从头播，不要停在片尾
  if (Number.isFinite(duration) && duration > 0 && target >= duration - 60) return null;
  if (!target || target < MIN_PLAY_PROGRESS_SECONDS) return null;
  return target;
}

function seekToTimestamp(seconds, { scroll = false } = {}) {
  const audio = $("#audio");
  if (!audio.src) return notify("当前没有可跳转的播放内容");
  const target = Math.max(0, Number(seconds) || 0);
  audio.currentTime = Math.min(target, audio.duration || target);
  audio.play().catch(() => notify("已定位时间点，请点击播放继续"));
  updateActiveProgressAnchor(target);
  if (scroll) {
    document.querySelector(`[data-content-timestamp="${Math.floor(target)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function renderEpisodeContentBlocks(episode) {
  const content = episodeContentOf(episode);
  const blocks = XYZEpisodeContent.parseContent(content);
  if (!blocks.length) return `<div class="empty">这期暂时没有 Show Notes 正文。</div>`;
  let listOpen = false;
  const output = [];
  const closeList = () => {
    if (listOpen) output.push("</ul>");
    listOpen = false;
  };

  blocks.forEach((block) => {
    if (block.type !== "bullet") closeList();
    if (block.type === "heading") {
      output.push(`<h2>${esc(block.text)}</h2>`);
    } else if (block.type === "timestamp") {
      const deepLink = timestampDeepLink(episode, block.seconds);
      output.push(`<div class="episode-timestamp-row" data-content-timestamp="${block.seconds}">
        <button class="timestamp-button" type="button" data-seek-seconds="${block.seconds}" title="跳转到 ${esc(block.label)}">${esc(block.label)}</button>
        <p>${esc(block.text || "从这里继续收听")}</p>
        ${deepLink ? `<a href="${esc(deepLink)}" title="在小宇宙打开这个时间点">小宇宙 ↗</a>` : ""}
      </div>`);
    } else if (block.type === "bullet") {
      if (!listOpen) {
        output.push('<ul class="episode-content-list">');
        listOpen = true;
      }
      output.push(`<li>${esc(block.text)}</li>`);
    } else {
      output.push(`<p>${esc(block.text)}</p>`);
    }
  });
  closeList();
  return output.join("");
}

function renderEpisodePage(root) {
  const episode = state.episodeView.episode;
  const image = imageOf(episode);
  const podcastTitle = episode?.podcast?.title || episode?.podcast?.name || "小宇宙节目";
  const published = episode?.pubDate || episode?.publishedAt || episode?.createdAt || "";
  const publishedText = published ? new Date(published).toLocaleString("zh-CN", { dateStyle: "medium" }) : "";
  const sourceUrl = episodeLinkOf(episode);
  const timeline = XYZEpisodeContent.extractTimeline(episodeContentOf(episode));
  const duration = durationOf(episode);
  root.innerHTML = `
    <article class="episode-content-page">
      <header class="episode-content-hero">
        <div class="episode-content-cover">${image ? `<img src="${esc(image)}" alt="${esc(titleOf(episode))}" />` : "<span>◌</span>"}</div>
        <div class="episode-content-heading">
          <div class="route-eyebrow">NOW PLAYING · SHOW NOTES</div>
          <h1>${esc(titleOf(episode))}</h1>
          <button class="episode-podcast-link" type="button" data-open-current-podcast>${esc(podcastTitle)}</button>
          <div class="episode-facts">
            ${duration ? `<span>${esc(formatTime(duration))}</span>` : ""}
            ${publishedText ? `<span>${esc(publishedText)}</span>` : ""}
            ${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noreferrer">真实单集链接 ↗</a>` : ""}
          </div>
          <div class="episode-content-actions">
            <button class="primary-button" type="button" data-toggle-current-play>${$("#audio").paused ? "播放" : "暂停"}</button>
            <button class="secondary-button" type="button" data-copy-current-link>复制单集链接</button>
          </div>
        </div>
      </header>
      ${timeline.length ? `<section class="episode-chapter-strip" aria-label="本期时间轴">
        ${timeline.map((item) => `<button type="button" data-seek-seconds="${item.seconds}"><strong>${esc(item.label)}</strong><span>${esc(item.text || "继续收听")}</span></button>`).join("")}
      </section>` : ""}
      <section class="episode-show-notes">
        <div class="section-heading"><h2>本期内容</h2><span>${timeline.length ? `${timeline.length} TIMESTAMPS` : "SHOW NOTES"}</span></div>
        <div class="episode-content-body">${renderEpisodeContentBlocks(episode)}</div>
      </section>
    </article>`;
  $$("[data-seek-seconds]", root).forEach((button) => button.addEventListener("click", () => seekToTimestamp(button.dataset.seekSeconds)));
  $("[data-open-current-podcast]", root)?.addEventListener("click", () => openPodcast(episode));
  $("[data-toggle-current-play]", root)?.addEventListener("click", (event) => {
    const audio = $("#audio");
    if (audio.paused) audio.play().catch(() => notify("播放失败，请稍后重试"));
    else audio.pause();
  });
  $("[data-copy-current-link]", root)?.addEventListener("click", () => copyEpisodeLink(episode));
}

function renderPodcastPage(root) {
  const view = state.podcastView;
  const podcast = view.podcast;
  const image = imageOf(podcast);
  const author = podcast?.author?.nickname || podcast?.author?.name || "小宇宙节目";
  const description = podcast?.description || podcast?.brief || podcast?.introduction || "暂无节目简介。";
  const subscribed = state.subscribedPids.has(podcastIdOf(podcast));
  root.innerHTML = `
    <section class="podcast-detail">
      <header class="podcast-detail-hero">
        <div class="podcast-detail-cover">${image ? `<img src="${esc(image)}" alt="${esc(titleOf(podcast))}" />` : "<span>◌</span>"}</div>
        <div class="podcast-detail-copy">
          <div class="route-eyebrow">PODCAST ARCHIVE</div>
          <h1>${esc(titleOf(podcast))}</h1>
          <p class="podcast-detail-author">${esc(author)}</p>
          <p class="podcast-detail-description">${esc(description)}</p>
          <div class="podcast-detail-actions">
            <button id="detail-subscribe" class="primary-button" type="button" ${subscribed ? "disabled" : ""}>${subscribed ? "已订阅" : "订阅节目"}</button>
            <button id="detail-copy-podcast" class="secondary-button" type="button">复制节目链接</button>
          </div>
        </div>
      </header>
      <div id="podcast-popular-container"></div>
      <div class="section-heading"><h2>全部单集</h2><span>EPISODE ARCHIVE</span></div>
      <div id="podcast-episodes" class="result-list">${view.episodes === null ? '<div class="loading">正在读取节目单集……</div>' : ""}</div>
    </section>`;
  $("#detail-subscribe").addEventListener("click", (event) => toggleSubscription(podcast, event.currentTarget));
  $("#detail-copy-podcast").addEventListener("click", () => copyPodcastLink(podcast));
  if (view.episodes === null) loadPodcastEpisodes(view);
  else renderPodcastEpisodes($("#podcast-episodes"), view.episodes);
}

async function loadPodcastPopularEpisodes(view) {
  const container = $("#podcast-popular-container");
  if (!container) return;
  const pid = podcastIdOf(view.podcast);
  if (!pid) return;
  try {
    const response = await api("/episode_popular", { pid, label: "POPULAR" });
    if (state.podcastView !== view) return;
    const popular = extractContent(response).filter((item) => episodeIdOf(item));
    if (!popular.length) {
      container.innerHTML = "";
      return;
    }
    view.popularEpisodes = popular;
    container.innerHTML = `<section class="popular-episodes-section">
      <div class="popular-episodes-heading">
        <span class="popular-badge">🔥 热门</span>
        <h3>节目内最受欢迎单集</h3>
      </div>
      <div id="podcast-popular-list" class="popular-list">
        ${popular.slice(0, 5).map((ep, i) => podcastEpisodeRow(ep, i)).join("")}
      </div>
    </section>`;
    const listHolder = $("#podcast-popular-list");
    if (listHolder) bindPodcastEpisodeRows(listHolder, popular.slice(0, 5));
  } catch {
    // 热门单集拉取失败时静默降级，不阻碍主列表展示
    if (container) container.innerHTML = "";
  }
}

async function loadPodcastEpisodes(view) {
  const holder = $("#podcast-episodes");
  loadPodcastPopularEpisodes(view).catch(() => {});
  try {
    const response = await api("/episode_list", { pid: podcastIdOf(view.podcast), order: "desc" });
    if (state.podcastView !== view) return;
    view.episodes = extractContent(response).filter((item) => episodeIdOf(item));
    renderPodcastEpisodes(holder, view.episodes);
  } catch (error) {
    if (state.podcastView !== view) return;
    holder.innerHTML = `<div class="empty">${esc(error.message)}<br /><button class="mini-button" data-retry-episodes>重新加载</button></div>`;
    holder.querySelector("[data-retry-episodes]")?.addEventListener("click", () => {
      holder.innerHTML = `<div class="loading">正在重新读取节目单集……</div>`;
      loadPodcastEpisodes(view);
    });
  }
}

function renderPodcastEpisodes(holder, episodes) {
  holder.innerHTML = episodes.length
    ? episodes.map((episode, index) => podcastEpisodeRow(episode, index)).join("")
    : `<div class="empty">这个节目暂时没有可展示的单集。</div>`;
  bindPodcastEpisodeRows(holder, episodes);
}

function podcastEpisodeRow(episode, index) {
  const published = episode?.pubDate || episode?.publishedAt || episode?.createdAt || "";
  const publishedText = published ? new Date(published).toLocaleDateString("zh-CN") : "节目单集";
  const secondaryActions = [
    `<button data-episode-action="download" role="menuitem">下载音频</button>`,
    `<button data-episode-action="transcribe" role="menuitem">${transcriptActionLabel()}</button>`,
    `<button data-episode-action="copy-episode" role="menuitem">复制单集链接</button>`,
    `<button data-episode-action="copy-podcast" role="menuitem">复制节目链接</button>`
  ].join("");
  return `<article class="episode-row podcast-episode-row" data-index="${index}">
    <div class="episode-thumb">${imageOf(episode) ? `<img src="${esc(imageOf(episode))}" alt="" />` : ""}</div>
    <div class="episode-meta"><strong>${esc(titleOf(episode))}</strong><span>${esc(publishedText)}</span></div>
    <div class="row-actions">
      <button class="row-action" data-episode-action="play">播放</button>
      <button class="row-action" data-episode-action="view-podcast">查看节目</button>
      ${summaryActionButton(episode, "row-action is-primary", 'data-episode-action="summarize"')}
      ${moreActions(secondaryActions, "action-menu-row")}
    </div>
  </article>`;
}

function bindPodcastEpisodeRows(holder, episodes) {
  $$(".podcast-episode-row", holder).forEach((row) => row.addEventListener("click", (event) => {
    const episode = episodes[Number(row.dataset.index)];
    const control = event.target.closest("button, summary");
    if (!control) return openEpisode(episode);
    if (control.tagName === "SUMMARY") return;
    const action = control.dataset.episodeAction;
    closeActionMenu(control);
    if (action === "play") openEpisode(episode);
    if (action === "view-podcast") openPodcast(episode);
    if (action === "summarize") summarizeEpisode(episode, control).catch((error) => notify(error.message));
    if (action === "copy-episode") copyEpisodeLink(episode);
      if (action === "add-playlist") addToPlaylist(episode);
    if (action === "copy-podcast") copyPodcastLink(episode);
    if (action === "download") downloadEpisodeAudio(episode);
    if (action === "transcribe") exportEpisodeTranscript(episode, control);
      if (action === "add-playlist") addToPlaylist(episode);
      if (action === "play-next") addToPlaylist(episode, { playNext: true });
  }));
}

function renderSettingsPage(root) {
  const settings = state.settings || {};
  const activeSettingsTab = state.settingsTab || "files";
  const panelHidden = (id) => activeSettingsTab === id ? "" : "hidden";
  const audioPath = String(settings.audioDownloadPath || "");
  const transcriptPath = String(settings.transcriptDownloadPath || "");
  const summaryPath = String(settings.summaryDownloadPath || "");
  state.summaryPromptDrafts = (settings.summaryPromptVersions || []).map((prompt) => ({ ...prompt }));
  const summaryProviderOptions = SUMMARY_PROVIDERS.map(
    (provider) => `<option value="${provider.id}">${provider.label}</option>`
  ).join("");
  const summaryProviderPanels = SUMMARY_PROVIDERS.map((provider) => {
    const config = settings.summaryProviders?.[provider.id] || {};
    return `<div class="provider-settings" data-summary-provider-settings="${provider.id}">
      <label>${provider.label} API Key
        <div class="credential-row"><input id="summary-${provider.id}-api-key" type="password" placeholder="已保存则留空；输入新值会覆盖" autocomplete="new-password" /><button class="mini-button" type="button" data-clear-summary-key="${provider.keyField}">清除</button></div>
      </label>
      <label>API Base URL 或完整地址<input id="summary-${provider.id}-endpoint" type="url" value="${esc(config.endpoint || "")}" /></label>
      <label>模型<input id="summary-${provider.id}-model" type="text" value="${esc(config.model || "")}" /></label>
    </div>`;
  }).join("");
  root.innerHTML = `
    <section class="settings-page">
      <div class="section-heading"><h2>设置</h2><span>PREFERENCES</span></div>
      <nav class="settings-tabs" role="tablist" aria-label="设置分类">
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "files"}" data-settings-tab="files" class="${activeSettingsTab === "files" ? "is-active" : ""}">文件与助手</button>
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "asr"}" data-settings-tab="asr" class="${activeSettingsTab === "asr" ? "is-active" : ""}">文字稿与 ASR</button>
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "summary"}" data-settings-tab="summary" class="${activeSettingsTab === "summary" ? "is-active" : ""}">AI 总结</button>
        <button type="button" role="tab" aria-selected="${activeSettingsTab === "advanced"}" data-settings-tab="advanced" class="${activeSettingsTab === "advanced" ? "is-active" : ""}">高级</button>
      </nav>
      <form id="settings-form" class="settings-form">
        <section class="settings-section settings-panel" data-settings-panel="files" ${panelHidden("files")}>
          <div class="settings-section-heading"><div><h3>文件与本地助手</h3></div><p>统一管理下载目录和 Native Host。</p></div>
          <label>音频保存目录
            <div class="path-input-row"><input id="audio-download-path" type="text" value="${esc(audioPath)}" placeholder="留空使用浏览器默认下载目录/小宇宙音频" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="audio-download-path">选择目录</button></div>
          </label>
          <p class="field-hint">实际位置：<code id="audio-path-preview"></code>。支持输入系统绝对路径或使用“选择目录”。</p>
          <label>文字稿保存目录
            <div class="path-input-row"><input id="transcript-download-path" type="text" value="${esc(transcriptPath)}" placeholder="留空使用浏览器默认下载目录/小宇宙转写稿" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="transcript-download-path">选择目录</button></div>
          </label>
          <p class="field-hint">实际位置：<code id="transcript-path-preview"></code>。</p>
          <label>AI 总结稿保存目录
            <div class="path-input-row"><input id="summary-download-path" type="text" value="${esc(summaryPath)}" placeholder="留空使用文字稿保存目录" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="summary-download-path">选择目录</button></div>
          </label>
          <p class="field-hint">实际位置：<code id="summary-path-preview"></code>。三个目录可分别配置。</p>
          <label class="checkbox-row"><input id="download-save-as" type="checkbox" ${settings.downloadSaveAs ? "checked" : ""} /><span>使用浏览器默认目录时，每次下载询问保存位置</span></label>
          <div id="native-host-status" class="native-host-status">正在检测本地文件助手……</div>
          <div class="native-install-guide">
            <strong id="native-install-title">本地助手安装</strong>
            <p id="native-install-description">正在识别操作系统并生成安装指令……</p>
          </div>
          <div id="native-host-diagnostics" class="native-host-diagnostics">
            <div><span>系统</span><code id="native-platform">检测中…</code></div>
            <div><span>扩展 ID</span><code id="native-extension-id">检测中…</code></div>
            <div><span>Manifest</span><code id="native-manifest-path">检测中…</code></div>
            <div><span>Host</span><code id="native-host-path">检测中…</code></div>
            <div><span>安装命令</span><code id="native-install-command">检测中…</code></div>
            <div class="native-host-actions">
              <button id="copy-native-install-command" class="mini-button" type="button">复制安装命令</button>
              <a id="native-host-help" href="https://github.com/QWE38qwe/xiaoyuzhou-desktop#3-安装-native-host" target="_blank" rel="noreferrer">查看安装说明</a>
            </div>
          </div>
        </section>
        <section class="settings-section settings-panel" data-settings-panel="asr" ${panelHidden("asr")}>
          <div class="settings-section-heading"><div><h3>文字稿与 ASR</h3></div><p>优先导出小宇宙官方文字稿；ASR 可按需启用。</p></div>
          <label>默认文字稿来源<select id="transcript-source"><option value="official">小宇宙官方文字稿（默认）</option><option value="asr">ASR 生成</option></select></label>
          <p id="official-transcript-hint" class="field-hint">有官方文字稿时会直接导出，并按节目 Show Notes 时间戳生成可跳转章节；本集没有官方稿时不会自动调用 ASR。</p>
          <div id="asr-settings-wrap">
          <label>ASR 服务<select id="asr-provider"><option value="local_qwen">本地 Qwen3-ASR</option><option value="qwen">Qwen API</option><option value="doubao">豆包 API</option></select></label>
          <div class="provider-settings" data-asr-provider-settings="local_qwen">
            <label>本地模型<select id="local-qwen-model"><option value="Qwen/Qwen3-ASR-0.6B">Qwen3-ASR 0.6B（推荐，约 1.2GB 内存）</option><option value="Qwen/Qwen3-ASR-1.7B">Qwen3-ASR 1.7B（高精度，约 3.4GB 内存）</option></select></label>
            <div id="local-qwen-status" class="native-host-status">正在检查本地 Qwen ASR……</div>
            <div class="setup-steps">
              <div><strong>1. 连接本地助手</strong><span>先在“文件与助手”完成 Native Host 安装。</span></div>
              <div><strong>2. 安装 0.6B 运行时</strong><span>推荐 Apple Silicon Mac 新用户使用，约需 1.2GB 运行内存。</span></div>
              <div><strong>3. 首次下载模型</strong><span>第一次转写会下载模型；后续直接复用缓存。</span></div>
              <div><strong>4. 按任务释放内存</strong><span>每次转写结束后 Worker 自动退出，不常驻后台。</span></div>
            </div>
            <div class="install-command-row"><code id="local-qwen-install-command">./install_local_asr.sh</code><button id="copy-local-asr-command" class="mini-button" type="button">复制安装命令</button></div>
            <p class="field-hint">Windows 暂不支持 MLX 本地模型，将自动引导使用 Qwen API 或豆包 API。</p>
          </div>
          <div class="provider-settings" data-asr-provider-settings="qwen">
            <label>Qwen API Key<input id="qwen-api-key" type="password" placeholder="已保存则留空；输入新值会覆盖" autocomplete="new-password" /></label>
            <label>API Base URL 或完整地址<input id="qwen-asr-endpoint" type="url" value="${esc(settings.qwenAsrEndpoint || "")}" placeholder="https://dashscope.aliyuncs.com/api/v1" /></label>
            <label>模型<input id="qwen-asr-model" type="text" list="qwen-asr-model-options" value="${esc(settings.qwenAsrModel || "qwen-audio-3.0-asr-flash-filetrans")}" /></label>
            <datalist id="qwen-asr-model-options">
              <option value="qwen-audio-3.0-asr-flash-filetrans"></option>
              <option value="fun-asr"></option>
              <option value="fun-asr-flash-2026-06-15"></option>
              <option value="qwen3-asr-flash-filetrans"></option>
              <option value="qwen3-asr-flash"></option>
            </datalist>
            <p class="field-hint">程序会按模型自动选择异步文件转写、DashScope 同步或 OpenAI-compatible 路径。长播客推荐 <code>qwen-audio-3.0-asr-flash-filetrans</code>；Fun-ASR-Flash 单次最多 5 分钟。</p>
          </div>
          <div class="provider-settings" data-asr-provider-settings="doubao">
            <label>豆包 API Key<input id="doubao-api-key" type="password" placeholder="已保存则留空；输入新值会覆盖" autocomplete="new-password" /></label>
            <label>接口地址<input id="doubao-asr-endpoint" type="url" value="${esc(settings.doubaoAsrEndpoint || "")}" /></label>
            <label>Resource ID<input id="doubao-asr-resource-id" type="text" value="${esc(settings.doubaoAsrResourceId || "volc.bigasr.auc_turbo")}" /></label>
          </div>
          <div id="asr-provider-status" class="native-host-status">正在检查 API 配置……</div>
          <p class="field-hint">转写稿优先保留模型返回的完整标点；模型未返回标点时，会依据语音片段停顿补充基础逗号和句号。</p>
          <p class="field-hint">API Key 由 Native Host 保存在 <span id="credential-storage-label">系统安全凭据存储</span>，扩展不会回显完整密钥。转写会将音频 URL 或音频内容发送至所选服务。</p>
          </div>
        </section>
        <section class="settings-section settings-panel summary-settings-section" data-settings-panel="summary" ${panelHidden("summary")}>
          <div class="settings-section-heading"><div><h3>AI 总结</h3></div><p>配置模型、评论补充和 Prompt。</p></div>
          <label>总结服务<select id="summary-provider">${summaryProviderOptions}</select></label>
          ${summaryProviderPanels}
          <label class="checkbox-row"><input id="summary-include-comments" type="checkbox" ${settings.summaryIncludeComments ? "checked" : ""} /><span>总结时补充评论区中的有效观点</span></label>
          <p class="field-hint">默认关闭。开启后会读取当前单集的公开评论，过滤“沙发、终于更新、等了好久”等低信息内容，再将有效评论发送给当前 AI Provider。</p>
          <div id="summary-provider-status" class="native-host-status">正在检查 AI API 配置……</div>
          <div class="summary-run-row">
            <button id="choose-summary-transcript" class="secondary-button" type="button">选择已有转写稿并总结</button>
            <span id="summary-action-status" class="field-hint">长转写稿会自动分段汇总。</span>
          </div>
          <div class="prompt-manager">
            <div class="prompt-manager-heading">
              <div><div class="route-eyebrow">PROMPT VERSIONS</div><strong>总结 Prompt 版本</strong></div>
              <span id="active-prompt-badge" class="prompt-badge"></span>
            </div>
            <label>选择版本<select id="summary-prompt-select"></select></label>
            <div class="prompt-meta-grid">
              <label>名称<input id="summary-prompt-name" type="text" maxlength="80" /></label>
              <label>版本<input id="summary-prompt-version" type="text" maxlength="32" /></label>
            </div>
            <label>Prompt<textarea id="summary-prompt-content" rows="18" maxlength="20000"></textarea></label>
            <div class="prompt-actions">
              <button id="clone-summary-prompt" class="secondary-button" type="button">复制为新版本</button>
              <button id="activate-summary-prompt" class="mini-button" type="button">设为当前</button>
              <button id="delete-summary-prompt" class="mini-button is-danger" type="button">删除版本</button>
            </div>
            <p class="field-hint">内置版本只读；自定义版本保存在 Chrome 本地存储。支持占位符 <code>{{title}}</code>。</p>
          </div>
        </section>
        <section class="settings-section settings-panel" data-settings-panel="advanced" ${panelHidden("advanced")}>
          <div class="settings-section-heading"><div><h3>高级设置</h3></div><p>请求路由与代理配置。</p></div>
          <label>请求模式<select id="api-mode"><option value="direct">扩展直连（本地开发）</option><option value="proxy">受控代理（生产推荐）</option></select></label>
          <label>代理地址<input id="proxy-url" type="url" value="${esc(settings.proxyBaseUrl || "")}" placeholder="https://your-proxy.example.com" /></label>
          <p class="field-hint">请勿将代理地址指向不可信服务。</p>
        </section>
        <button class="primary-button settings-save" type="submit">保存设置</button>
      </form>
    </section>`;
  $$("[data-settings-tab]").forEach((button) => button.addEventListener("click", () => {
    state.settingsTab = button.dataset.settingsTab;
    $$("[data-settings-tab]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
    });
    $$("[data-settings-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== state.settingsTab;
    });
  }));
  $("#api-mode").value = settings.apiMode || "direct";
  $("#transcript-source").value = settings.transcriptSource || "official";
  $("#asr-provider").value = settings.asrProvider || "qwen";
  $("#local-qwen-model").value = settings.localQwenModel || "Qwen/Qwen3-ASR-0.6B";
  let nativeStatus = null;
  const renderLocalQwenStatus = () => {
    const localNode = $("#local-qwen-status");
    if (!localNode || !nativeStatus) return;
    const model = $("#local-qwen-model").value;
    const cached = Boolean(nativeStatus.localQwen?.cachedModels?.[model]);
    const supported = nativeStatus.localQwen?.supported !== false;
    localNode.classList.toggle("is-ready", nativeStatus.localQwen?.available);
    localNode.textContent = !supported
      ? nativeStatus.localQwen?.reason || "当前系统不支持本地 Qwen3-ASR"
      : nativeStatus.localQwen?.available
      ? `本地运行时已安装 · 当前模型${cached ? "已缓存" : "将在首次使用时下载"}`
      : "本地运行时未安装，请执行 ./install_local_asr.sh";
  };
  $("#local-qwen-model").addEventListener("change", renderLocalQwenStatus);
  const updateAsrProviderSettings = () => {
    $$("[data-asr-provider-settings]").forEach((node) => {
      node.hidden = node.dataset.asrProviderSettings !== $("#asr-provider").value;
    });
  };
  const updateTranscriptSourceSettings = () => {
    const usingAsr = $("#transcript-source").value === "asr";
    $("#asr-settings-wrap").hidden = !usingAsr;
    $("#official-transcript-hint").hidden = usingAsr;
  };
  updateAsrProviderSettings();
  updateTranscriptSourceSettings();
  $("#asr-provider").addEventListener("change", updateAsrProviderSettings);
  $("#transcript-source").addEventListener("change", updateTranscriptSourceSettings);
  $("#summary-provider").value = settings.summaryProvider || "qwen";
  const updateSummaryProviderSettings = () => {
    $$("[data-summary-provider-settings]").forEach((node) => {
      node.hidden = node.dataset.summaryProviderSettings !== $("#summary-provider").value;
    });
  };
  updateSummaryProviderSettings();
  $("#summary-provider").addEventListener("change", updateSummaryProviderSettings);
  initializeSummaryPromptManager(settings.activeSummaryPromptId);
  const updatePreview = () => {
    const audioValue = $("#audio-download-path").value.trim();
    const transcriptValue = $("#transcript-download-path").value.trim();
    const summaryValue = $("#summary-download-path").value.trim();
    $("#audio-path-preview").textContent = audioValue || "浏览器默认下载目录/小宇宙音频";
    $("#transcript-path-preview").textContent = transcriptValue || "浏览器默认下载目录/小宇宙转写稿";
    $("#summary-path-preview").textContent = summaryValue || transcriptValue || "浏览器默认下载目录/小宇宙转写稿";
    $("#download-save-as").disabled = Boolean(audioValue);
  };
  updatePreview();
  $("#audio-download-path").addEventListener("input", updatePreview);
  $("#transcript-download-path").addEventListener("input", updatePreview);
  $("#summary-download-path").addEventListener("input", updatePreview);
  $$("[data-choose-directory]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const prompts = {
        "audio-download-path": "请选择音频保存目录",
        "transcript-download-path": "请选择文字稿保存目录",
        "summary-download-path": "请选择 AI 总结稿保存目录"
      };
      const prompt = prompts[button.dataset.chooseDirectory] || "请选择保存目录";
      const data = await send("choose-native-directory", { prompt });
      $(`#${button.dataset.chooseDirectory}`).value = data.path;
      updatePreview();
    } catch (error) {
      notify(error.message);
    }
  }));
  $("#copy-native-install-command").addEventListener("click", async () => {
    const command = $("#native-install-command").textContent;
    try {
      await navigator.clipboard.writeText(command);
      notify("Native Host 安装命令已复制");
    } catch {
      notify(command);
    }
  });
  $("#copy-local-asr-command").addEventListener("click", async () => {
    const command = $("#local-qwen-install-command").textContent;
    if (!command || command === "当前系统不支持") {
      notify("Windows 暂不支持本地 Qwen3-ASR，请使用 API 模式");
      return;
    }
    try {
      await navigator.clipboard.writeText(command);
      notify("本地 Qwen 安装命令已复制");
    } catch {
      notify(command);
    }
  });
  $$("[data-clear-summary-key]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("确认从系统安全凭据存储中删除这个 AI 总结 API Key？")) return;
    try {
      const status = await send("save-summary-credentials", {
        clearKeys: [button.dataset.clearSummaryKey]
      });
      renderSummaryProviderStatus(status.summaryConfigured || {});
      notify("API Key 已从 Keychain 删除");
    } catch (error) {
      notify(error.message);
    }
  }));
  $("#choose-summary-transcript").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    try {
      button.disabled = true;
      button.textContent = "选择中…";
      const selected = await send("import-summary-transcript");
      await summarizeTranscriptPath(selected.path, button, $("#summary-action-status"));
    } catch (error) {
      $("#summary-action-status").textContent = error.message;
      notify(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "选择已有转写稿并总结";
    }
  });
  $("#settings-form").addEventListener("submit", saveSettings);
  send("get-native-host-status").then((status) => {
    nativeStatus = status;
    const node = $("#native-host-status");
    if (!node) return;
    node.classList.toggle("is-ready", status.available);
    node.textContent = status.available
      ? `本地文件助手已连接 · ${status.version || "可用"}`
      : `本地文件助手未连接，目录选择、ASR 和 AI 总结不可用。${status.error || ""}`;
    const isWindows = status.platform === "windows";
    $("#native-platform").textContent = isWindows ? "Windows" : "macOS";
    $("#native-install-title").textContent = isWindows
      ? "Windows 安装步骤"
      : "macOS 安装步骤";
    $("#native-install-description").textContent = isWindows
      ? "先安装 Python 3 并勾选 Add Python to PATH；随后在项目目录用 PowerShell 执行下方命令，完成后在 chrome://extensions 重新加载扩展。"
      : "在项目目录用终端执行下方命令；完成后重新加载扩展。";
    $("#native-extension-id").textContent = status.extensionId || "未知";
    $("#native-manifest-path").textContent = status.manifestPath || "未知";
    $("#native-host-path").textContent = status.hostPath || "未知";
    $("#native-install-command").textContent = status.installCommand || "未知";
    $("#native-host-help").href = status.helpUrl;
    $("#credential-storage-label").textContent = status.credentialStorage
      || (isWindows ? "Windows DPAPI" : "macOS Keychain");
    const localOption = $("#asr-provider option[value=local_qwen]");
    const localSupported = status.localQwen?.supported !== false && !isWindows;
    localOption.disabled = !localSupported;
    $("#local-qwen-install-command").textContent = localSupported
      ? status.localAsrInstallCommand || "./install_local_asr.sh"
      : "当前系统不支持";
    $("#copy-local-asr-command").disabled = !localSupported;
    if (!localSupported && $("#asr-provider").value === "local_qwen") {
      $("#asr-provider").value = "qwen";
      updateAsrProviderSettings();
      notify("Windows 暂不支持本地 Qwen3-ASR，已切换到 Qwen API");
    }
    $$("[data-choose-directory]").forEach((button) => {
      button.disabled = !status.available;
      button.title = status.available ? "" : "请先安装并连接 Native Host";
    });
    $("#choose-summary-transcript").disabled = !status.available;
    const providerNode = $("#asr-provider-status");
    if (!providerNode) return;
    providerNode.classList.toggle("is-ready", status.qwenConfigured || status.doubaoConfigured || status.localQwen?.available);
    providerNode.textContent = `本地 Qwen：${status.localQwen?.available ? "已安装" : "未安装"} · Qwen API：${status.qwenConfigured ? "已配置" : "未配置"} · 豆包 API：${status.doubaoConfigured ? "已配置" : "未配置"}`;
    renderLocalQwenStatus();
    renderSummaryProviderStatus(status.summaryConfigured || {});
  });
}

function renderSummaryProviderStatus(configured = {}) {
  const node = $("#summary-provider-status");
  if (!node) return;
  const configuredCount = SUMMARY_PROVIDERS.filter((provider) => configured[provider.id]).length;
  node.classList.toggle("is-ready", configuredCount > 0);
  node.textContent = SUMMARY_PROVIDERS.map(
    (provider) => `${provider.label}：${configured[provider.id] ? "已配置" : "未配置"}`
  ).join(" · ");
}

function incrementPromptVersion(value) {
  const parts = String(value || "1.0.0").split(".");
  const last = Number(parts[parts.length - 1]);
  if (Number.isInteger(last)) {
    parts[parts.length - 1] = String(last + 1);
    return parts.join(".");
  }
  return `${value || "1.0.0"}.1`;
}

function summaryPromptById(id) {
  return state.summaryPromptDrafts.find((prompt) => prompt.id === id);
}

function syncSummaryPromptEditor() {
  const prompt = summaryPromptById(state.summaryPromptEditorId);
  if (!prompt || prompt.builtin || !$("#summary-prompt-content")) return;
  prompt.name = $("#summary-prompt-name").value.trim() || "自定义总结 Prompt";
  prompt.version = $("#summary-prompt-version").value.trim() || "1.0.0";
  prompt.content = $("#summary-prompt-content").value.trim();
}

function refreshSummaryPromptSelect(selectedId) {
  const select = $("#summary-prompt-select");
  select.innerHTML = state.summaryPromptDrafts.map((prompt) =>
    `<option value="${esc(prompt.id)}">${esc(prompt.name)} · v${esc(prompt.version)}${prompt.builtin ? "（内置）" : ""}</option>`
  ).join("");
  select.value = selectedId;
}

function loadSummaryPromptEditor(id) {
  const prompt = summaryPromptById(id) || state.summaryPromptDrafts[0];
  if (!prompt) return;
  state.summaryPromptEditorId = prompt.id;
  $("#summary-prompt-select").value = prompt.id;
  $("#summary-prompt-name").value = prompt.name;
  $("#summary-prompt-version").value = prompt.version;
  $("#summary-prompt-content").value = prompt.content;
  $("#summary-prompt-name").readOnly = Boolean(prompt.builtin);
  $("#summary-prompt-version").readOnly = Boolean(prompt.builtin);
  $("#summary-prompt-content").readOnly = Boolean(prompt.builtin);
  $("#delete-summary-prompt").disabled = Boolean(prompt.builtin);
  $("#activate-summary-prompt").disabled = prompt.id === state.settings.activeSummaryPromptId;
  const active = summaryPromptById(state.settings.activeSummaryPromptId) || state.summaryPromptDrafts[0];
  $("#active-prompt-badge").textContent = active
    ? `当前：${active.name} v${active.version}`
    : "未选择";
}

function initializeSummaryPromptManager(activeId) {
  if (!state.summaryPromptDrafts.length) return;
  state.settings.activeSummaryPromptId = activeId || state.summaryPromptDrafts[0].id;
  refreshSummaryPromptSelect(state.settings.activeSummaryPromptId);
  loadSummaryPromptEditor(state.settings.activeSummaryPromptId);
  $("#summary-prompt-select").addEventListener("change", (event) => {
    syncSummaryPromptEditor();
    loadSummaryPromptEditor(event.target.value);
  });
  $("#clone-summary-prompt").addEventListener("click", () => {
    syncSummaryPromptEditor();
    const source = summaryPromptById(state.summaryPromptEditorId) || state.summaryPromptDrafts[0];
    const copy = {
      id: `custom-${crypto.randomUUID()}`,
      name: `${source.name} 副本`,
      version: incrementPromptVersion(source.version),
      content: source.content,
      builtin: false
    };
    state.summaryPromptDrafts.push(copy);
    refreshSummaryPromptSelect(copy.id);
    loadSummaryPromptEditor(copy.id);
  });
  $("#activate-summary-prompt").addEventListener("click", () => {
    syncSummaryPromptEditor();
    state.settings.activeSummaryPromptId = state.summaryPromptEditorId;
    loadSummaryPromptEditor(state.summaryPromptEditorId);
    notify("已设为当前 Prompt，保存设置后生效");
  });
  $("#delete-summary-prompt").addEventListener("click", () => {
    const prompt = summaryPromptById(state.summaryPromptEditorId);
    if (!prompt || prompt.builtin || !confirm(`确认删除 Prompt 版本“${prompt.name}”？`)) return;
    state.summaryPromptDrafts = state.summaryPromptDrafts.filter((item) => item.id !== prompt.id);
    if (state.settings.activeSummaryPromptId === prompt.id) {
      state.settings.activeSummaryPromptId = state.summaryPromptDrafts[0].id;
    }
    refreshSummaryPromptSelect(state.settings.activeSummaryPromptId);
    loadSummaryPromptEditor(state.settings.activeSummaryPromptId);
  });
}

function podcastLinkOf(item) {
  const pid = podcastIdOf(item);
  return pid ? `https://www.xiaoyuzhoufm.com/podcast/${pid}` : "";
}

function episodeLinkOf(item) {
  const eid = episodeIdOf(item);
  return eid ? `https://www.xiaoyuzhoufm.com/episode/${eid}` : "";
}

function renderPlayerAnchors(item = null) {
  const holder = $("#progress-anchors");
  if (!holder) return;
  const timeline = item ? XYZEpisodeContent.extractTimeline(episodeContentOf(item)) : [];
  const audioDuration = Number($("#audio")?.duration);
  const duration = Number.isFinite(audioDuration) && audioDuration > 0
    ? audioDuration
    : durationOf(item) || (timeline.at(-1)?.seconds || 0);
  holder.innerHTML = duration > 0
    ? timeline.map((entry) => {
      const left = Math.max(0, Math.min(100, entry.seconds / duration * 100));
      const tooltip = `${entry.label} ${entry.text || "继续收听"}`;
      return `<button
        type="button"
        style="--anchor-position:${left}%"
        data-progress-seconds="${entry.seconds}"
        data-tooltip="${esc(tooltip)}"
        title="${esc(tooltip)}"
        aria-label="${esc(`跳转到 ${entry.label} ${entry.text || ""}`)}"
      ></button>`;
    }).join("")
    : "";
  $$("[data-progress-seconds]", holder).forEach((button) => {
    button.addEventListener("click", () => seekToTimestamp(button.dataset.progressSeconds, { scroll: true }));
  });
  updateActiveProgressAnchor($("#audio")?.currentTime || 0);
}

function updateActiveProgressAnchor(seconds) {
  const anchors = $$("[data-progress-seconds]");
  let active = null;
  anchors.forEach((anchor) => {
    anchor.classList.remove("is-active");
    if (Number(anchor.dataset.progressSeconds) <= seconds + 0.25) active = anchor;
  });
  active?.classList.add("is-active");
}

async function copyLink(url, label) {
  if (!url) return notify(`当前没有可复制的${label}链接`);
  try { await navigator.clipboard.writeText(url); notify("链接已复制"); } catch { notify(url); }
}

function copyEpisodeLink(item) {
  return copyLink(episodeLinkOf(item), "单集");
}

function copyPodcastLink(item) {
  return copyLink(podcastLinkOf(item), "节目");
}

function updatePlayerLinkButtons(item = null) {
  const hasAudio = Boolean(audioOf(item));
  const canExportOfficialTranscript = Boolean(episodeIdOf(item));
  const canExportTranscript = state.settings?.transcriptSource === "asr"
    ? hasAudio
    : canExportOfficialTranscript;
  const summaryButton = $("#summarize-button");
  const summarized = Boolean(summaryRecordOf(item));
  $("#download-audio-button").disabled = !hasAudio;
  $("#transcribe-audio-button").disabled = !canExportTranscript;
  $("#transcribe-audio-button").textContent = transcriptActionLabel();
  $("#transcribe-audio-button").title = transcriptSourceLabel();
  summaryButton.disabled = !canExportTranscript;
  summaryButton.textContent = summarized ? "已 AI 总结" : "AI 总结";
  summaryButton.classList.toggle("is-complete", summarized);
  summaryButton.title = summarized
    ? "已有总结，再次点击可重新生成"
    : "导出文字稿并总结当前单集";
  $("#view-podcast-button").disabled = !podcastIdOf(item);
  $("#copy-episode-link-button").disabled = !episodeLinkOf(item);
  $("#copy-podcast-link-button").disabled = !podcastLinkOf(item);
}

async function resolveEpisode(item) {
  if (!item) return;
  let eid = episodeIdOf(item);
  let episode = item;
  if (!eid && podcastIdOf(item)) {
    const response = await api("/episode_list", { pid: podcastIdOf(item), order: "desc" });
    const episodes = extractContent(response).filter((candidate) => episodeIdOf(candidate));
    episode = episodes[0] || item;
    eid = episodeIdOf(episode);
  }
  if (eid && state.episodeDetails.has(eid)) {
    return state.episodeDetails.get(eid);
  }
  if (eid) {
    try {
      const detail = unwrapDetail(await api("/episode_detail", { eid }, "GET"));
      episode = {
        ...episode,
        ...detail,
        podcast: detail?.podcast || episode?.podcast
      };
      state.episodeDetails.set(eid, episode);
    } catch (error) {
      if (!audioOf(episode)) throw error;
      episode = { ...episode, detailLoadError: error.message };
    }
  }
  return episode;
}

async function downloadEpisodeAudio(item) {
  try {
    const episode = await resolveEpisode(item);
    const audio = audioOf(episode);
    if (!audio) return notify("这集暂时没有可下载的音频地址");
    const result = await send("download-audio", { payload: { url: audio, filename: audioFilenameOf(episode) } });
    if (result?.path) notify(`音频已保存：${result.path}`);
    else notify(state.settings?.downloadSaveAs ? "请选择本地保存位置" : "已开始下载音频");
  } catch (error) {
    notify(error.message);
  }
}

function transcriptSourceLabel(source = state.settings?.transcriptSource) {
  return source === "asr" ? asrProviderLabel() : "小宇宙官方文字稿";
}

function transcriptTimelineOf(episode) {
  return XYZEpisodeContent.extractTimeline(episodeContentOf(episode))
    .map((entry) => ({
      seconds: entry.seconds,
      label: entry.label,
      title: entry.text || ""
    }));
}

function rememberTranscriptExport(episode, result) {
  const transcriptPath = result.markdown || result.md || result.txt;
  if (!transcriptPath) throw new Error("文字稿导出完成但未返回文件路径");
  state.currentTranscriptPath = transcriptPath;
  state.currentTranscriptEpisodeId = episodeIdOf(episode);
  state.currentTranscriptSegments = [];
  state.currentSummaryPath = "";
  return transcriptPath;
}

async function exportOfficialEpisodeTranscript(item, button = null, { propagate = false } = {}) {
  const originalText = button?.textContent;
  try {
    const episode = await resolveEpisode(item);
    const eid = episodeIdOf(episode);
    if (!eid) throw new Error("无法识别需要导出文字稿的单集");
    if (button) {
      button.disabled = true;
      button.textContent = "导出中…";
    }
    setTranscriptionStatus("正在导出小宇宙官方文字稿，请保持窗口打开");
    notify("正在导出小宇宙官方文字稿");
    const filename = audioFilenameOf(episode);
    const result = await send("export-official-transcript", {
      payload: {
        episodeId: eid,
        baseName: filename.replace(/\.[^.]+$/, ""),
        episodeUrl: episodeLinkOf(episode),
        timeline: transcriptTimelineOf(episode)
      }
    });
    const transcriptPath = rememberTranscriptExport(episode, result);
    const timestampNote = result.chapterCount
      ? ` · 已按节目时间轴整理为 ${result.chapterCount} 个章节`
      : " · 节目未提供时间轴，已输出连续文稿";
    setTranscriptionStatus(`官方文字稿导出完成${timestampNote}：${transcriptPath}`, "success");
    notify(`官方文字稿已导出：${transcriptPath}`);
    return transcriptPath;
  } catch (error) {
    setTranscriptionStatus(`文字稿导出失败：${error.message}`, "error");
    if (!propagate) notify(error.message);
    if (propagate) throw error;
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function transcribeEpisodeAudio(item, button = null, { propagate = false } = {}) {
  const originalText = button?.textContent;
  try {
    const episode = await resolveEpisode(item);
    const audio = audioOf(episode);
    if (!audio) throw new Error("这集暂时没有可转写的音频地址");
    if (button) {
      button.disabled = true;
      button.textContent = "转写中…";
    }
    const providerLabel = state.settings?.asrProvider === "local_qwen"
      ? "本地 Qwen"
      : state.settings?.asrProvider === "doubao"
        ? "豆包"
        : "Qwen";
    setTranscriptionStatus(`${providerLabel} 长音频转写中，请保持窗口打开`);
    notify(`${providerLabel} ASR 正在转写，请保持窗口打开`);
    const filename = audioFilenameOf(episode);
    const result = await send("transcribe-audio", {
      payload: {
        url: audio,
        filename,
        baseName: filename.replace(/\.[^.]+$/, ""),
        language: "zh",
        episodeId: episodeIdOf(episode),
        episodeUrl: episodeLinkOf(episode),
        timeline: transcriptTimelineOf(episode)
      }
    });
    const transcriptPath = rememberTranscriptExport(episode, result);
    const timestampNote = result.chapterCount
      ? ` · 已按节目时间轴整理为 ${result.chapterCount} 个章节`
      : " · 节目未提供时间轴，已输出连续文稿";
    setTranscriptionStatus(`转写完成${timestampNote}：${transcriptPath}`, "success");
    notify(`转写完成：${transcriptPath}`);
    return transcriptPath;
  } catch (error) {
    setTranscriptionStatus(`转写失败：${error.message}`, "error");
    if (!propagate) notify(error.message);
    if (propagate) throw error;
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function exportEpisodeTranscript(item, button = null, options = {}) {
  return state.settings?.transcriptSource === "asr"
    ? transcribeEpisodeAudio(item, button, options)
    : exportOfficialEpisodeTranscript(item, button, options);
}

function summaryProviderLabel(providerId = state.settings?.summaryProvider) {
  return SUMMARY_PROVIDERS.find((provider) => provider.id === providerId)?.label || providerId || "AI Provider";
}

function asrProviderLabel(providerId = state.settings?.asrProvider) {
  return {
    local_qwen: "本机 Qwen3-ASR（音频不外发）",
    qwen: "Qwen API",
    doubao: "豆包 API"
  }[providerId] || "当前 ASR 服务";
}

function ensureSummaryConsent() {
  if (state.settings?.summaryConsentAccepted) return Promise.resolve(true);
  const dialog = $("#summary-consent-dialog");
  $("#summary-consent-provider").textContent = summaryProviderLabel();
  $("#summary-consent-asr").textContent = transcriptSourceLabel();
  $("#summary-consent-comments").textContent = state.settings?.summaryIncludeComments
    ? "筛选后的公开评论也会一并发送。"
    : "评论不会被读取或发送。";
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    dialog.addEventListener("close", () => finish(false), { once: true });
    $("#summary-consent-confirm").onclick = async () => {
      try {
        state.settings = await send("update-settings", {
          settings: { summaryConsentAccepted: true }
        });
        finish(true);
        dialog.close();
      } catch (error) {
        notify(error.message);
      }
    };
    dialog.showModal();
  });
}

function ensureResummarize(episode) {
  const record = summaryRecordOf(episode);
  if (!record) return Promise.resolve(true);
  const dialog = $("#resummarize-dialog");
  const createdAt = record.createdAt
    ? new Date(record.createdAt).toLocaleString("zh-CN")
    : "此前";
  $("#resummarize-detail").textContent = `${createdAt} 已生成过总结。`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    dialog.addEventListener("close", () => finish(false), { once: true });
    $("#resummarize-confirm").onclick = () => {
      finish(true);
      dialog.close();
    };
    dialog.showModal();
  });
}

async function summarizeTranscriptPath(
  transcriptPath,
  button = null,
  statusNode = null,
  { skipConsent = false, episodeId = "" } = {}
) {
  if (!transcriptPath) throw new Error("请先生成或选择 Markdown 转写稿");
  if (!skipConsent && !await ensureSummaryConsent()) return null;
  const originalText = button?.textContent;
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "总结中…";
    }
    if (statusNode) statusNode.textContent = `${summaryProviderLabel()} 正在总结，请保持窗口打开`;
    setTranscriptionStatus(`${summaryProviderLabel()} AI 正在总结，请保持窗口打开`);
    const result = await send("summarize-transcript", {
      payload: { transcriptPath, episodeId }
    });
    const summaryPath = result.markdown;
    if (!summaryPath) throw new Error("AI 总结完成但未返回 Markdown 路径");
    state.currentSummaryPath = summaryPath;
    if (episodeId) {
      state.summaryHistory.set(episodeId, {
        markdown: summaryPath,
        provider: result.provider,
        model: result.model,
        createdAt: new Date().toISOString(),
        commentCount: result.commentCount || 0
      });
      refreshSummaryIndicators(episodeId);
    }
    const commentNote = result.commentWarning
      ? `；评论补充失败：${result.commentWarning}`
      : result.commentCount
        ? `；已补充 ${result.commentCount} 条有效评论`
        : "";
    if (statusNode) statusNode.textContent = `总结完成${commentNote}：${summaryPath}`;
    setTranscriptionStatus(`AI 总结完成${commentNote}：${summaryPath}`, "success");
    notify(`AI 总结完成${commentNote}`);
    return result;
  } catch (error) {
    if (statusNode) statusNode.textContent = `总结失败：${error.message}`;
    setTranscriptionStatus(`AI 总结失败：${error.message}`, "error");
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      const completed = episodeId && state.summaryHistory.has(episodeId);
      button.textContent = completed ? "已 AI 总结" : originalText;
      button.classList.toggle("is-complete", Boolean(completed));
    }
  }
}

async function summarizeEpisode(item, button = null) {
  const episode = await resolveEpisode(item);
  const eid = episodeIdOf(episode);
  if (!eid) throw new Error("无法识别需要总结的单集");
  if (!await ensureResummarize(episode)) return null;
  if (!await ensureSummaryConsent()) return null;
  const hasMatchingTranscript = (
    state.currentTranscriptPath
    && state.currentTranscriptEpisodeId === eid
  );
  const transcriptPath = hasMatchingTranscript
    ? state.currentTranscriptPath
    : await exportEpisodeTranscript(episode, button, { propagate: true });
  return summarizeTranscriptPath(
    transcriptPath,
    button,
    null,
    { skipConsent: true, episodeId: eid }
  );
}

async function openEpisode(item) {
  try {
    const episode = await resolveEpisode(item);
    if (!episode) return;
    // 同一集已经在播放：打开详情页，不要重新播放
    if (episodeIdOf(episode) && episodeIdOf(state.current) === episodeIdOf(episode)) {
      if (!state.episodeView) {
        state.episodeView = { episode, scrollY: window.scrollY };
        renderRoute();
      }
      return;
    }
    const audio = audioOf(episode);
    if (!audio) return notify("这集暂时没有可播放的音频地址");
    state.current = episode;
    if (state.currentTranscriptEpisodeId !== episodeIdOf(episode)) {
      state.currentTranscriptPath = "";
      state.currentTranscriptEpisodeId = "";
      state.currentTranscriptSegments = [];
    }
    state.currentSummaryPath = summaryRecordOf(episode)?.markdown || "";
    setTranscriptionStatus();
    updatePlayerLinkButtons(episode);
    const player = $("#audio");
    player.src = audio;
    // 记录当前会话的续播位置，等 loadedmetadata 后恢复
    state.pendingResume = null;
    resumePlaybackPosition(episode, player).then((seconds) => {
      if (seconds == null) return;
      // 只有当前仍是这一集才恢复，避免用户切走后又被拉回
      if (episodeIdOf(state.current) !== episodeIdOf(episode)) return;
      state.pendingResume = seconds;
      const status = $("#transcription-status");
      if (status) {
        status.hidden = false;
        status.textContent = `将从 ${formatTime(seconds)} 继续播放`;
      }
      if (player.readyState >= 1) {
        player.currentTime = seconds;
        state.pendingResume = null;
      }
    }).catch(() => {});
    $("#player-title").textContent = titleOf(episode);
    $("#player-title").onclick = () => {
      if (state.current) openPodcast(state.current);
    };
    $("#player-title").title = "点击查看节目";
    $("#player-title").style.cursor = "pointer";
    $("#player-subtitle").textContent = episode?.podcast?.title || episode?.podcast?.name || "小宇宙单集";
    const image = imageOf(episode);
    $("#player-cover").innerHTML = image ? `<img src="${esc(image)}" alt="" />` : "<span>◌</span>";
    $("#player-cover").onclick = () => {
      if (state.current) openPodcast(state.current);
    };
    $("#player-cover").title = "点击查看节目";
    $("#player-cover").style.cursor = "pointer";
    state.episodeView = {
      episode,
      scrollY: window.scrollY
    };
    $("#route-eyebrow").textContent = "EPISODE NOTES";
    $("#route-title").textContent = titleOf(episode);
    $("#back-button").hidden = false;
    renderPlayerAnchors(episode);
    renderRoute();
    window.scrollTo({ top: 0, behavior: "smooth" });
    try { await player.play(); } catch { notify("浏览器阻止了自动播放，请点击播放按钮"); }
    markEpisodePlayed(episode);
  } catch (error) {
    notify(error.message);
  }
}

async function toggleSubscription(item, button = null) {
  const pid = podcastIdOf(item);
  if (!pid) return notify("无法识别这个节目");
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "订阅中…";
  }
  try {
    await api("/subscription_update", { pid, mode: "ON" });
    state.subscribedPids.add(pid);
    if (button) button.textContent = "已订阅";
    notify("已加入订阅");
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
    notify(error.message);
  }
}

function drawLoginQrcode(text) {
  const canvas = $("#login-qrcode-canvas");
  const status = $("#login-qrcode-status");
  if (!canvas || typeof qrcode !== "function") {
    if (status) status.textContent = "二维码组件加载失败，请重新打开登录窗口";
    return;
  }
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  // 用固定基准计算缩放：canvas.width 会被下面覆写，不能作为基准，否则每刷新一次都变小
  const scale = Math.max(2, Math.floor(LOGIN_QRCODE_BASE_SIZE / (count + 2)));
  const size = count * scale;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#19191d";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col)) {
        ctx.fillRect(col * scale, row * scale, scale, scale);
      }
    }
  }
}

function stopLoginPolling() {
  openLogin.session = null;
  if (openLogin.timer) {
    clearTimeout(openLogin.timer);
    clearInterval(openLogin.timer);
    openLogin.timer = null;
  }
}

async function startLoginQrcode() {
  const status = $("#login-qrcode-status");
  const errorNode = $("#login-error");
  stopLoginPolling();
  errorNode.textContent = "";
  status.className = "code-status is-pending";
  status.textContent = "正在生成二维码…";
  try {
    const { id, url } = await send("create-login-qrcode");
    drawLoginQrcode(url);
    status.className = "code-status";
    status.textContent = "请用手机小宇宙 App 扫码，并在手机上确认登录";
    const session = {};
    openLogin.session = session;
    let ticks = 0;
    const fail = (message) => {
      stopLoginPolling();
      status.className = "code-status is-error";
      status.textContent = message;
    };
    // 用递归 setTimeout 而不是 setInterval：避免上一次请求还没回来就叠下一次
    const tick = async () => {
      if (openLogin.session !== session) return;
      ticks += 1;
      if (ticks > 60) {
        fail("二维码已过期，请点击「刷新二维码」");
        return;
      }
      try {
        const result = await send("poll-login-qrcode", { payload: { id } });
        if (openLogin.session !== session) return;
        switch (result?.status) {
          case "authorized":
            stopLoginPolling();
            state.auth = await send("get-auth");
            $("#login-dialog").close();
            markConnection();
            renderRoute();
            notify("登录成功");
            return;
          case "scanned":
            status.className = "code-status is-pending";
            status.textContent = "已扫码，请在手机上确认登录";
            break;
          case "expired":
            fail("二维码已过期，请点击「刷新二维码」");
            return;
          case "canceled":
            fail("已取消登录，请点击「刷新二维码」重新开始");
            return;
          default:
            break;
        }
      } catch (pollError) {
        fail(pollError.message);
        return;
      }
      openLogin.timer = setTimeout(tick, 2000);
    };
    openLogin.timer = setTimeout(tick, 2000);
  } catch (error) {
    status.className = "code-status is-error";
    status.textContent = error.message;
  }
}

function openLogin() {
  $("#login-error").textContent = "";
  $("#login-dialog").showModal();
  startLoginQrcode();
}

function openLogoutConfirmation() {
  $("#logout-dialog").showModal();
}

async function confirmLogout() {
  const button = $("#logout-confirm");
  button.disabled = true;
  button.textContent = "正在退出…";
  try {
    await send("logout");
    state.auth = null;
    $("#logout-dialog").close();
    markConnection();
    renderRoute();
    notify("已退出登录");
  } catch (error) {
    notify(`退出失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "确认退出登录";
  }
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    syncSummaryPromptEditor();
    if (state.summaryPromptDrafts.some((prompt) => !String(prompt.content || "").trim())) {
      throw new Error("AI 总结 Prompt 内容不能为空");
    }
    const asrCredentialStatus = await send("save-asr-credentials", {
      credentials: {
        qwenApiKey: $("#qwen-api-key").value.trim(),
        doubaoApiKey: $("#doubao-api-key").value.trim()
      }
    });
    const summaryCredentials = Object.fromEntries(SUMMARY_PROVIDERS.map((provider) => [
      provider.keyField,
      $(`#summary-${provider.id}-api-key`).value.trim()
    ]));
    const summaryCredentialStatus = await send("save-summary-credentials", {
      credentials: summaryCredentials
    });
    const summaryProviders = Object.fromEntries(SUMMARY_PROVIDERS.map((provider) => [
      provider.id,
      {
        endpoint: $(`#summary-${provider.id}-endpoint`).value.trim(),
        model: $(`#summary-${provider.id}-model`).value.trim()
      }
    ]));
    const includeComments = $("#summary-include-comments").checked;
    const keepConsent = Boolean(
      state.settings.summaryConsentAccepted
      && (!includeComments || state.settings.summaryIncludeComments)
    );
    state.settings = await send("update-settings", {
      settings: {
        apiMode: $("#api-mode").value,
        proxyBaseUrl: $("#proxy-url").value.trim(),
        downloadFolder: "小宇宙音频",
        transcriptFolder: "小宇宙转写稿",
        audioDownloadPath: $("#audio-download-path").value.trim(),
        transcriptDownloadPath: $("#transcript-download-path").value.trim(),
        summaryDownloadPath: $("#summary-download-path").value.trim(),
        downloadSaveAs: $("#download-save-as").checked,
        transcriptSource: $("#transcript-source").value,
        asrProvider: $("#asr-provider").value,
        localQwenModel: $("#local-qwen-model").value,
        qwenAsrEndpoint: $("#qwen-asr-endpoint").value.trim(),
        qwenAsrModel: $("#qwen-asr-model").value.trim(),
        doubaoAsrEndpoint: $("#doubao-asr-endpoint").value.trim(),
        doubaoAsrResourceId: $("#doubao-asr-resource-id").value.trim(),
        summaryProvider: $("#summary-provider").value,
        summaryProviders,
        summaryPromptVersions: state.summaryPromptDrafts.map((prompt) => ({ ...prompt })),
        activeSummaryPromptId: state.settings.activeSummaryPromptId,
        summaryConsentAccepted: keepConsent,
        summaryIncludeComments: includeComments
      }
    });
    $("#qwen-api-key").value = "";
    $("#doubao-api-key").value = "";
    SUMMARY_PROVIDERS.forEach((provider) => {
      $(`#summary-${provider.id}-api-key`).value = "";
    });
    const providerNode = $("#asr-provider-status");
    if (providerNode) {
      providerNode.classList.toggle("is-ready", asrCredentialStatus.qwenConfigured || asrCredentialStatus.doubaoConfigured || asrCredentialStatus.localQwen?.available);
      providerNode.textContent = `本地 Qwen：${asrCredentialStatus.localQwen?.available ? "已安装" : "未安装"} · Qwen API：${asrCredentialStatus.qwenConfigured ? "已配置" : "未配置"} · 豆包 API：${asrCredentialStatus.doubaoConfigured ? "已配置" : "未配置"}`;
    }
    renderSummaryProviderStatus(summaryCredentialStatus.summaryConfigured || {});
    $("#audio-download-path").value = state.settings.audioDownloadPath;
    $("#transcript-download-path").value = state.settings.transcriptDownloadPath;
    $("#summary-download-path").value = state.settings.summaryDownloadPath;
    $("#audio-path-preview").textContent = state.settings.audioDownloadPath || "浏览器默认下载目录/小宇宙音频";
    $("#transcript-path-preview").textContent = state.settings.transcriptDownloadPath || "浏览器默认下载目录/小宇宙转写稿";
    $("#summary-path-preview").textContent = state.settings.summaryDownloadPath
      || state.settings.transcriptDownloadPath
      || "浏览器默认下载目录/小宇宙转写稿";
    updatePlayerLinkButtons(state.current);
    notify("设置已保存");
  } catch (error) {
    notify(error.message);
  }
}

function initPlayer() {
  const audio = $("#audio");
  const closePlayerMenu = () => $("#player-more-menu").removeAttribute("open");
  $("#play-button").addEventListener("click", () => { if (!audio.src) return notify("先选择一集播客"); if (audio.paused) audio.play(); else audio.pause(); });
  $("#skip-back").addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
  $("#skip-forward").addEventListener("click", () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 30); });
  $("#add-playlist-button").addEventListener("click", () => {
    if (state.current) addToPlaylist(state.current);
    $("#player-more-menu").removeAttribute("open");
  });
  $("#favorite-button").addEventListener("click", () => {
    if (state.current) toggleFavorite(state.current);
    $("#player-more-menu").removeAttribute("open");
  });
  $("#speed-button").addEventListener("click", (event) => {
    const next = audio.playbackRate >= 2 ? 1 : audio.playbackRate + .5;
    audio.playbackRate = next;
    event.currentTarget.textContent = `播放速度 · ${next}×`;
    closePlayerMenu();
  });
  $("#player-queue-button")?.addEventListener("click", () => setRoute("playlist"));
  $("#view-podcast-button").addEventListener("click", () => state.current ? openPodcast(state.current) : notify("当前没有正在播放的节目"));
  $("#download-audio-button").addEventListener("click", () => {
    closePlayerMenu();
    return state.current ? downloadEpisodeAudio(state.current) : notify("当前没有正在播放的单集");
  });
  $("#transcribe-audio-button").addEventListener("click", (event) => {
    closePlayerMenu();
    return state.current ? exportEpisodeTranscript(state.current, event.currentTarget) : notify("当前没有正在播放的单集");
  });
  $("#summarize-button").addEventListener("click", (event) => {
    if (!state.current) return notify("当前没有正在播放的单集");
    summarizeEpisode(state.current, event.currentTarget).catch((error) => notify(error.message));
  });
  $("#copy-episode-link-button").addEventListener("click", () => {
    closePlayerMenu();
    return state.current ? copyEpisodeLink(state.current) : notify("当前没有正在播放的单集");
  });
  $("#copy-podcast-link-button").addEventListener("click", () => {
    closePlayerMenu();
    return state.current ? copyPodcastLink(state.current) : notify("当前没有正在播放的节目");
  });
  audio.addEventListener("play", () => {
    $("#play-button").textContent = "Ⅱ";
    $("[data-toggle-current-play]")?.replaceChildren("暂停");
  });
  audio.addEventListener("pause", () => {
    $("#play-button").textContent = "▶";
    $("[data-toggle-current-play]")?.replaceChildren("播放");
  });
  audio.addEventListener("loadedmetadata", () => {
    $("#duration").textContent = formatTime(audio.duration);
    renderPlayerAnchors(state.current);
    if (state.pendingResume != null && state.current) {
      const target = state.pendingResume;
      state.pendingResume = null;
      if (audio.duration > 0) audio.currentTime = Math.min(target, audio.duration - 1);
      notify(`已从 ${formatTime(target)} 继续播放`);
    }
  });
  audio.addEventListener("timeupdate", () => {
    $("#current-time").textContent = formatTime(audio.currentTime);
    $("#progress").value = audio.duration
      ? (audio.currentTime / audio.duration) * 100
      : 0;
    updateActiveProgressAnchor(audio.currentTime);
    // 只在播放中上报进度，暂停时不产生无意义的请求
    if (!audio.paused && state.current) {
      scheduleProgressReport(state.current, Math.floor(audio.currentTime));
    }
  });
  audio.addEventListener("ended", () => {
    playNextInPlaylist().catch(() => {});
  });
  const flushNow = () => {
    if (state.progressTimer) {
      clearTimeout(state.progressTimer);
      state.progressTimer = null;
    }
    flushProgressReport();
  };
  audio.addEventListener("pause", flushNow);
  audio.addEventListener("ended", flushNow);
  window.addEventListener("beforeunload", flushNow);
  $("#progress").addEventListener("input", (event) => { if (audio.duration) audio.currentTime = (event.target.value / 100) * audio.duration; });
  initVolumeControl(audio);
}

function volumeIconFor(level, muted) {
  if (muted || level <= 0) return "🔇";
  if (level < 34) return "🔈";
  if (level < 67) return "🔉";
  return "🔊";
}

function applyVolume(audio, level, { muted = false, persist = true } = {}) {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  const effective = muted ? 0 : clamped / 100;
  audio.volume = effective;
  audio.muted = muted || clamped === 0;

  const slider = $("#volume-slider");
  const label = $("#volume-value");
  const icon = $("#volume-icon");
  const button = $("#volume-button");
  if (slider) slider.value = String(clamped);
  if (label) label.textContent = muted ? "静音" : String(clamped);
  if (icon) icon.textContent = volumeIconFor(clamped, muted || clamped === 0);
  if (button) {
    button.classList.toggle("is-muted", muted || clamped === 0);
    button.title = muted ? "已静音，点击恢复" : `音量 ${clamped}`;
  }

  if (persist) {
    try {
      localStorage.setItem(VOLUME_KEY, String(clamped));
      localStorage.setItem(VOLUME_MUTED_KEY, muted ? "true" : "false");
    } catch {
      // 存储不可用时忽略，音量仍然作用于当前会话
    }
  }
  return clamped;
}

function initVolumeControl(audio) {
  const control = $("#volume-control");
  const button = $("#volume-button");
  const slider = $("#volume-slider");
  if (!control || !button || !slider) return;

  // 恢复上次的音量；没有记录时用 100
  const saved = Number.parseInt(localStorage.getItem(VOLUME_KEY) ?? "100", 10);
  const savedMuted = localStorage.getItem(VOLUME_MUTED_KEY) === "true";
  applyVolume(audio, Number.isFinite(saved) ? saved : 100, { muted: savedMuted, persist: false });

  const setExpanded = (expanded) => {
    control.dataset.volumeExpanded = expanded ? "true" : "false";
    button.setAttribute("aria-expanded", String(expanded));
  };

  // 点击图标：展开滑块；已展开时点击切换静音
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const expanded = control.dataset.volumeExpanded === "true";
    if (!expanded) {
      setExpanded(true);
      slider.focus();
      return;
    }
    const level = Number.parseInt(slider.value, 10) || 0;
    const nextMuted = !(audio.muted || level === 0);
    applyVolume(audio, level === 0 ? 50 : level, { muted: nextMuted });
  });

  slider.addEventListener("input", (event) => {
    applyVolume(audio, Number(event.target.value), { muted: false });
  });

  // 双击图标快速静音/恢复
  button.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    const level = Number.parseInt(slider.value, 10) || 0;
    const nextMuted = !(audio.muted || level === 0);
    applyVolume(audio, level === 0 ? 50 : level, { muted: nextMuted });
  });

  // 点击别处收起滑块
  document.addEventListener("click", (event) => {
    if (!control.contains(event.target)) setExpanded(false);
  });
  control.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setExpanded(false);
  });

  // 滚轮在图标上快速调整
  control.addEventListener("wheel", (event) => {
    if (control.dataset.volumeExpanded !== "true") return;
    event.preventDefault();
    const level = Number.parseInt(slider.value, 10) || 0;
    const next = level + (event.deltaY < 0 ? 5 : -5);
    applyVolume(audio, next, { muted: false });
  }, { passive: false });
}

async function syncPermissionBanner() {
  try {
    const result = await send("check-host-permissions");
    const banner = $("#permission-banner");
    if (banner) banner.hidden = Boolean(result?.granted);
  } catch {
    // 后台未提供该消息时静默忽略
  }
}

async function init() {
  const [auth, settings, history] = await Promise.all([
    send("get-auth"),
    send("get-settings"),
    send("get-summary-history")
  ]);
  state.auth = auth;
  state.settings = settings;
  state.summaryHistory = new Map(Object.entries(history || {}));
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  $("#back-button").hidden = true;
  markConnection(); initPlayer(); loadPlaylist().catch(() => {}); renderRoute();
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => setRoute(item.dataset.route)));
  $("#back-button").addEventListener("click", () => {
    if (state.episodeView) closeEpisode();
    else closePodcast();
  });
  $("#sidebar-toggle").addEventListener("click", () => setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed")));
  $("#permission-grant").addEventListener("click", async () => {
    try {
      const result = await send("request-host-permissions");
      if (result?.granted) {
        $("#permission-banner").hidden = true;
        notify("已获得网站访问权限");
      }
    } catch (error) {
      notify(error.message);
    }
  });
  syncPermissionBanner();
  $("#account-button").addEventListener("click", () => {
    if (state.auth) openLogoutConfirmation();
    else openLogin();
  });
  $("#logout-confirm").addEventListener("click", confirmLogout);
  $("#login-form").addEventListener("submit", (event) => event.preventDefault());
  $("#login-qrcode-refresh").addEventListener("click", () => startLoginQrcode());
  $("#login-dialog").addEventListener("close", () => stopLoginPolling());
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  document.addEventListener("click", (event) => {
    const activeMenu = event.target.closest(".action-menu");
    $$(".action-menu[open]").forEach((menu) => {
      if (menu !== activeMenu) menu.removeAttribute("open");
    });
  });
}

init().catch((error) => notify(error.message));
