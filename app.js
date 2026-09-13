Warning: truncated output (original token count: 26249)
Total output lines: 2273

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const SIDEBAR_COLLAPSED_KEY = "xyzSidebarCollapsed";
const AUTH_SESSION_KEY = "xyzAuthSession";
const SUMMARY_PROVIDERS = [
  { id: "qwen", label: "Qwen", keyField: "summaryQwenApiKey" },
  { id: "doubao", label: "豆包", keyField: "summaryDoubaoApiKey" },
  { id: "deepseek", label: "DeepSeek", keyField: "summaryDeepseekApiKey" },
  { id: "kimi", label: "Kimi", keyField: "summaryKimiApiKey" },
  { id: "glm", label: "GLM", keyField: "summaryGlmApiKey" },
  { id: "openrouter", label: "OpenRouter", keyField: "" }
];
const SUMMARY_PROVIDER_DEFAULTS = {
  qwen: { endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-plus" },
  doubao: { endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions", model: "doubao-seed-2-1-pro-260628" },
  deepseek: { endpoint: "https://api.deepseek.com/chat/completions", model: "deepseek-v4-flash" },
  kimi: { endpoint: "https://api.moonshot.cn/v1/chat/completions", model: "kimi-k2.6" },
  glm: { endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", model: "glm-5.2" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions", model: "qwen/qwen3.7-plus" }
};

const state = {
  route: "discover",
  searchType: "episode",
  feed: [],
  subscriptions: [],
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
  summaryModelDrafts: [],
  summaryModelCredentialStatus: {},
  summaryModelEditorId: "",
  summaryModelMutationPending: false,
  summaryPromptDrafts: [],
  summaryPromptEditorId: ""
};

const routeMeta = {
  discover: ["EXPLORE", "发现"],
  search: ["FIND YOUR NEXT STORY", "搜索"],
  subscriptions: ["YOUR LIBRARY", "我的订阅"],
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

function transcriptActionLabel() {
  return "ASR 转写";
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
  $("#account-label").textContent = state.auth
    ? accountName || "账号"
    : "登录";
  account.classList.toggle("is-logged", Boolean(state.auth));
}

function renderRoute() {
  const root = $("#page-content");
  document.body.classList.toggle("episode-reading-layout", Boolean(state.episodeView));
  if (state.episodeView) return renderEpisodePage(root);
  if (state.podcastView) return renderPodcastPage(root);
  if (state.route === "search") return renderSearchPage(root);
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
    <div class="section-heading"><h2>为你精选</h2><span>CURATED FOR YOU</span></div>
    <div id="discover-feed" class="feed-grid"><div class="loading">正在接收今天的声音……</div></div>`;
  loadDiscovery();
}

async function loadDiscovery() {
  const holder = $("#discover-feed");
  try {
    let lastError;
    for (const [endpoint, body] of [["/editor_pick", {}], ["/discovery", {}], ["/top_list", { category: "HOT" }]]) {
      try {
        const items = extractContent(await api(endpoint, body));
        if (items.length) {
          state.feed = items;
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (!state.feed.length && lastError) {
      throw lastError;
    }
    if (!state.feed.length) {
      holder.innerHTML = `<div class="empty">暂无发现内容。请确认登录状态或稍后重试。</div>`;
      return;
    }
    holder.innerHTML = state.feed.slice(0, 12).map((item, index) => podcastCard(item, index)).join("");
    bindCardActions(holder, state.feed);
  } catch (error) {
    holder.innerHTML = `<div class="empty">${esc(error.message)}<br /><button class="mini-button" data-action="login">去登录</button></div>`;
    holder.querySelector("[data-action=login]")?.addEventListener("click", openLogin);
  }
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
  root.innerHTML = `<section><div class="section-heading"><h2>我的订阅</h2><span>YOUR SUBSCRIPTIONS</span></div><div id="subscriptions-list" class="feed-grid"><div class="loading">正在读取你的订阅……</div></div></section>`;
  loadSubscriptions();
}

async function loadSubscriptions() {
  const holder = $("#subscriptions-list");
  try {
    const response = await api("/subscription", { limit: "20", sortOrder: "desc", sortBy: "subscribedAt" });
    state.subscriptions = listOf(response).map(itemOf).filter((item) => item?.type === "PODCAST");
    state.subscriptions.forEach((item) => state.subscribedPids.add(podcastIdOf(item)));
    holder.innerHTML = state.subscriptions.length ? state.subscriptions.slice(0, 18).map((item, index) => podcastCard(item, index)).join("") : `<div class="empty">还没有订阅节目。去发现页逛逛吧。</div>`;
    bindCardActions(holder, state.subscriptions);
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
  const published = episode?.pubDate || episode?.publishedAt || episode?.createdAt || "";
  const publishedText = published ? new Date(published).toLocaleString("zh-CN", { dateStyle: "medium" }) : "";
  const sourceUrl = episodeLinkOf(episode);
  const timeline = XYZEpisodeContent.extractTimeline(episodeContentOf(episode));
  const duration = durationOf(episode);
  root.innerHTML = `
    <article class="episode-content-page">
      <header class="episode-reading-header">
        <h1>${esc(titleOf(episode))}</h1>
        <div class="episode-content-meta" aria-label="单集信息">
          ${duration ? `<span>${esc(formatTime(duration))}</span>` : ""}
          ${publishedText ? `<span>${esc(publishedText)}</span>` : ""}
          ${sourceUrl ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noreferrer">真实单集链接 ↗</a>` : ""}
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
      <div class="section-heading"><h2>全部单集</h2><span>EPISODE ARCHIVE</span></div>
      <div id="podcast-episodes" class="result-list">${view.episodes === null ? '<div class="loading">正在读取节目单集……</div>' : ""}</div>
    </section>`;
  $("#detail-subscribe").addEventListener("click", (event) => toggleSubscription(podcast, event.currentTarget));
  $("#detail-copy-podcast").addEventListener("click", () => copyPodcastLink(podcast));
  if (view.episodes === null) loadPodcastEpisodes(view);
  else renderPodcastEpisodes($("#podcast-episodes"), view.episodes);
}

async function loadPodcastEpisodes(view) {
  const holder = $("#podcast-episodes");
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
    if (action === "copy-podcast") copyPodcastLink(episode);
    if (action === "download") downloadEpisodeAudio(episode);
    if (action === "transcribe") exportEpisodeTranscript(episode, control);
  }));
}

function summaryProviderMeta(providerId) {
  return SUMMARY_PROVIDERS.find((provider) => provider.id === providerId)
    || SUMMARY_PROVIDERS[0];
}

function summaryModelById(id) {
  return state.summaryModelDrafts.find((model) => model.id === id);
}

function summaryModelHost(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "接口地址无效";
  }
}

function renderSummaryModelStatus() {
  const node = $("#summary-provider-status");
  if (!node) return;
  const enabled = state.summaryModelDrafts.filter((model) => model.enabled);
  const configured = enabled.filter((model) => state.…6249 tokens truncated…{title}}</code>。</p>
          </div>
        </section>
        <section class="settings-section settings-panel" data-settings-panel="account" ${panelHidden("account")}>
          <div class="settings-section-heading"><h3>账号与会话</h3></div>
          <div class="account-setting-row">
            <div><strong>${esc(state.auth?.user?.nickname || state.auth?.user?.name || "小宇宙账号")}</strong><span>${state.auth ? "已连接 · 60 分钟无账户请求后自动退出" : "当前未登录"}</span></div>
            ${state.auth ? '<button id="settings-logout-button" class="danger-button" type="button">退出登录</button>' : '<button id="settings-login-button" class="secondary-button" type="button">登录</button>'}
          </div>
        </section>
        ${activeSettingsTab === "account" ? "" : '<button class="primary-button settings-save" type="submit">保存设置</button>'}
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
  updateAsrProviderSettings();
  $("#asr-provider").addEventListener("change", updateAsrProviderSettings);
  renderSummaryModelList();
  $("#add-summary-model").addEventListener("click", () => openSummaryModelEditor());
  $("#settings-logout-button")?.addEventListener("click", openLogoutConfirmation);
  $("#settings-login-button")?.addEventListener("click", openLogin);
  initializeSummaryPromptManager(settings.activeSummaryPromptId);
  const updatePreview = () => {
    const audioValue = $("#audio-download-path").value.trim();
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
    $(".native-install-guide").hidden = status.available;
    $("#native-host-diagnostics").hidden = status.available;
    const isWindows = status.platform === "windows";
    $("#native-platform").textContent = isWindows ? "Windows" : "macOS";
    $("#native-install-title").textContent = isWindows
      ? "Windows 安装步骤"
      : "macOS 安装步骤";
    $("#native-install-description").textContent = isWindows
      ? "安装 Python 3 后执行下方命令；完成后彻底退出所有 Chrome 进程，再重新打开浏览器。"
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
    refreshSummaryModelCredentialStatus();
  });
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

function showPlayerTimestampTooltip(button) {
  const tooltip = $("#player-timestamp-tooltip");
  const track = button.closest(".player-progress-track");
  if (!tooltip || !track) return;
  tooltip.textContent = button.dataset.label || "";
  tooltip.classList.add("is-visible");
  requestAnimationFrame(() => {
    const width = tooltip.offsetWidth;
    const trackRect = track.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const center = buttonRect.left + buttonRect.width / 2;
    const viewportCenter = Math.max(width / 2 + 12, Math.min(window.innerWidth - width / 2 - 12, center));
    tooltip.style.left = `${viewportCenter - trackRect.left}px`;
  });
}

function hidePlayerTimestampTooltip() {
  $("#player-timestamp-tooltip")?.classList.remove("is-visible");
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
        data-label="${esc(tooltip)}"
        aria-label="${esc(`跳转到 ${entry.label} ${entry.text || ""}`)}"
      ></button>`;
    }).join("")
    : "";
  $$("[data-progress-seconds]", holder).forEach((button) => {
    button.addEventListener("click", () => seekToTimestamp(button.dataset.progressSeconds, { scroll: true }));
    button.addEventListener("mouseenter", () => showPlayerTimestampTooltip(button));
    button.addEventListener("focus", () => showPlayerTimestampTooltip(button));
    button.addEventListener("mouseleave", hidePlayerTimestampTooltip);
    button.addEventListener("blur", hidePlayerTimestampTooltip);
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
  const hasSummaryModel = Boolean(state.settings?.summaryModels?.some((model) => model.enabled));
  const summaryButton = $("#summarize-button");
  const summarized = Boolean(summaryRecordOf(item));
  $("#download-audio-button").disabled = !hasAudio;
  $("#transcribe-audio-button").disabled = !hasAudio;
  $("#transcribe-audio-button").textContent = transcriptActionLabel();
  $("#transcribe-audio-button").title = transcriptSourceLabel();
  summaryButton.disabled = !hasAudio || !hasSummaryModel;
  summaryButton.textContent = summarized ? "已 AI 总结" : "AI 总结";
  summaryButton.classList.toggle("is-complete", summarized);
  summaryButton.title = summarized
    ? "已有总结，再次点击可重新生成"
    : hasSummaryModel
      ? "导出文字稿并总结当前单集"
      : "请先在设置中启用 AI 总结模型";
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

function transcriptSourceLabel() {
  return asrProviderLabel();
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
  return transcribeEpisodeAudio(item, button, options);
}

function summaryProviderLabel() {
  const model = state.settings?.summaryModels?.find((item) => item.enabled);
  return model?.name || "当前 AI 模型";
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
  $("#summary-consent-comments").textContent = "评论不会被读取或发送。";
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
        modelName: result.modelName || result.model,
        createdAt: new Date().toISOString(),
        commentCount: 0
      });
      refreshSummaryIndicators(episodeId);
    }
    if (statusNode) statusNode.textContent = `总结完成：${summaryPath}`;
    setTranscriptionStatus(`AI 总结完成：${summaryPath}`, "success");
    notify("AI 总结完成");
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
    : "";
  let resolvedTranscriptPath = transcriptPath;
  if (!resolvedTranscriptPath) {
    const existing = await send("find-existing-transcript", {
      episodeId: eid
    });
    if (existing?.path) {
      resolvedTranscriptPath = rememberTranscriptExport(episode, {
        markdown: existing.path
      });
      setTranscriptionStatus(
        `已复用现有转写稿：${resolvedTranscriptPath}`,
        "success"
      );
    } else {
      resolvedTranscriptPath = await exportEpisodeTranscript(
        episode,
        button,
        { propagate: true }
      );
    }
  }
  return summarizeTranscriptPath(
    resolvedTranscriptPath,
    button,
    null,
    { skipConsent: true, episodeId: eid }
  );
}

async function openEpisode(item) {
  try {
    const episode = await resolveEpisode(item);
    if (!episode) return;
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
    $("#player-title").textContent = titleOf(episode);
    $("#player-subtitle").textContent = episode?.podcast?.title || episode?.podcast?.name || "小宇宙单集";
    const image = imageOf(episode);
    $("#player-cover").innerHTML = image ? `<img src="${esc(image)}" alt="" />` : "<span>◌</span>";
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

function openLogin() {
  $("#login-error").textContent = "";
  $("#code-status").className = "code-status";
  $("#code-status").textContent = "在官方窗口完成登录后，返回这里点击“同步官方登录”。";
  $("#login-dialog").showModal();
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

async function openOfficialLogin() {
  const errorNode = $("#login-error");
  const statusNode = $("#code-status");
  const button = $("#open-official-login-button");
  errorNode.textContent = "";
  button.disabled = true;
  button.textContent = "打开中…";
  statusNode.className = "code-status is-pending";
  statusNode.textContent = "正在打开小宇宙官方登录窗口…";
  try {
    await send("open-official-login");
    statusNode.className = "code-status is-success";
    statusNode.textContent = "请在官方窗口完成登录，完成后返回这里点击“同步官方登录”。";
    notify("已打开小宇宙官方登录窗口");
  } catch (error) {
    statusNode.className = "code-status is-error";
    statusNode.textContent = "无法打开小宇宙官方登录窗口，请重试。";
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "重新打开官方登录";
  }
}

async function syncOfficialLogin() {
  const errorNode = $("#login-error");
  const statusNode = $("#code-status");
  const button = $("#sync-official-login-button");
  errorNode.textContent = "";
  button.disabled = true;
  button.textContent = "同步中…";
  statusNode.className = "code-status is-pending";
  statusNode.textContent = "正在验证小宇宙官方登录态…";
  try {
    state.auth = await send("sync-official-login");
    statusNode.className = "code-status is-success";
    statusNode.textContent = "官方登录态已同步。";
    markConnection();
    $("#login-dialog").close();
    notify("登录成功");
    renderRoute();
  } catch (error) {
    statusNode.className = "code-status is-error";
    statusNode.textContent = "未能同步官方登录态。请确认已在官方窗口完成登录后重试。";
    errorNode.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = "同步官方登录";
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
    const keepConsent = Boolean(state.settings.summaryConsentAccepted);
    state.settings = await send("update-settings", {
      settings: {
        downloadFolder: "小宇宙音频",
        transcriptFolder: "小宇宙转写稿",
        audioDownloadPath: $("#audio-download-path").value.trim(),
        transcriptDownloadPath: $("#transcript-download-path").value.trim(),
        summaryDownloadPath: $("#summary-download-path").value.trim(),
        downloadSaveAs: $("#download-save-as").checked,
        transcriptSource: "asr",
        asrProvider: $("#asr-provider").value,
        localQwenModel: $("#local-qwen-model").value,
        qwenAsrEndpoint: $("#qwen-asr-endpoint").value.trim(),
        qwenAsrModel: $("#qwen-asr-model").value.trim(),
        doubaoAsrEndpoint: $("#doubao-asr-endpoint").value.trim(),
        doubaoAsrResourceId: $("#doubao-asr-resource-id").value.trim(),
        summaryModels: state.summaryModelDrafts.map((model) => ({ ...model })),
        summaryPromptVersions: state.summaryPromptDrafts.map((prompt) => ({ ...prompt })),
        activeSummaryPromptId: state.settings.activeSummaryPromptId,
        summaryConsentAccepted: keepConsent,
        summaryIncludeComments: false
      }
    });
    $("#qwen-api-key").value = "";
    $("#doubao-api-key").value = "";
    const providerNode = $("#asr-provider-status");
    if (providerNode) {
      providerNode.classList.toggle("is-ready", asrCredentialStatus.qwenConfigured || asrCredentialStatus.doubaoConfigured || asrCredentialStatus.localQwen?.available);
      providerNode.textContent = `本地 Qwen：${asrCredentialStatus.localQwen?.available ? "已安装" : "未安装"} · Qwen API：${asrCredentialStatus.qwenConfigured ? "已配置" : "未配置"} · 豆包 API：${asrCredentialStatus.doubaoConfigured ? "已配置" : "未配置"}`;
    }
    refreshSummaryModelCredentialStatus();
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
  $("#speed-button").addEventListener("click", (event) => {
    const next = audio.playbackRate >= 2 ? 1 : audio.playbackRate + .5;
    audio.playbackRate = next;
    event.currentTarget.textContent = `播放速度 · ${next}×`;
    closePlayerMenu();
  });
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
  });
  audio.addEventListener("pause", () => {
    $("#play-button").textContent = "▶";
  });
  audio.addEventListener("loadedmetadata", () => {
    $("#duration").textContent = formatTime(audio.duration);
    renderPlayerAnchors(state.current);
  });
  audio.addEventListener("timeupdate", () => {
    $("#current-time").textContent = formatTime(audio.currentTime);
    $("#progress").value = audio.duration
      ? (audio.currentTime / audio.duration) * 100
      : 0;
    updateActiveProgressAnchor(audio.currentTime);
  });
  $("#progress").addEventListener("input", (event) => { if (audio.duration) audio.currentTime = (event.target.value / 100) * audio.duration; });
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
  markConnection(); initPlayer(); initializeSummaryModelDialog(); renderRoute();
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => setRoute(item.dataset.route)));
  $("#back-button").addEventListener("click", () => {
    if (state.episodeView) closeEpisode();
    else closePodcast();
  });
  $("#sidebar-toggle").addEventListener("click", () => setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed")));
  $("#account-button").addEventListener("click", () => {
    if (!state.auth) return openLogin();
    state.settingsTab = "account";
    setRoute("settings");
  });
  $("#logout-confirm").addEventListener("click", confirmLogout);
  $("#open-official-login-button").addEventListener("click", openOfficialLogin);
  $("#sync-official-login-button").addEventListener("click", syncOfficialLogin);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session" || !changes[AUTH_SESSION_KEY] || changes[AUTH_SESSION_KEY].newValue) return;
    state.auth = null;
    markConnection();
    renderRoute();
    notify("登录已超时，请重新授权");
  });
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  document.addEventListener("click", (event) => {
    const activeMenu = event.target.closest(".action-menu");
    $$(".action-menu[open]").forEach((menu) => {
      if (menu !== activeMenu) menu.removeAttribute("open");
    });
  });
}

init().catch((error) => notify(error.message));

