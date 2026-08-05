const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const SIDEBAR_COLLAPSED_KEY = "xyzSidebarCollapsed";
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
  subscriptions: [],
  current: null,
  auth: null,
  settings: null,
  searchRequest: 0,
  searchKeyword: "",
  searchResults: null,
  podcastView: null,
  subscribedPids: new Set(),
  currentTranscriptPath: "",
  currentTranscriptEpisodeId: "",
  currentSummaryPath: "",
  summaryPromptDrafts: [],
  summaryPromptEditorId: ""
};

const routeMeta = {
  discover: ["EXPLORE", "发现"],
  search: ["FIND YOUR NEXT STORY", "搜索"],
  subscriptions: ["YOUR LIBRARY", "我的订阅"],
  settings: ["PREFERENCES", "设置"]
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
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
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
  account.textContent = state.auth?.user?.nickname || state.auth?.user?.name || (state.auth ? "已登录" : "登录");
  account.classList.toggle("is-logged", Boolean(state.auth));
}

function renderRoute() {
  const root = $("#page-content");
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
  const summary = canResolveEpisode ? `<button class="mini-button is-accent" data-card-action="summarize">AI 总结</button>` : "";
  const secondaryActions = [
    canViewPodcast ? `<button data-card-action="subscribe" role="menuitem" ${subscribed ? "disabled" : ""}>${subscribed ? "已订阅" : "订阅节目"}</button>` : "",
    canResolveEpisode ? `<button data-card-action="download" role="menuitem">下载音频</button>` : "",
    canResolveEpisode ? `<button data-card-action="transcribe" role="menuitem">ASR 转写</button>` : "",
    episodeIdOf(item) ? `<button data-card-action="copy-episode" role="menuitem">复制单集链接</button>` : "",
    canViewPodcast ? `<button data-card-action="copy-podcast" role="menuitem">复制节目链接</button>` : ""
  ].join("");
  return `<article class="podcast-card" data-index="${index}">
    <div class="cover">${image ? `<img src="${esc(image)}" alt="" loading="lazy" />` : ""}</div>
    <div class="card-copy"><strong title="${esc(titleOf(item))}">${esc(titleOf(item))}</strong><span>${esc(item?.podcast?.author?.nickname || item?.author?.nickname || item?.description || "小宇宙精选节目")}</span></div>
    <div class="card-actions"><button class="mini-button" data-card-action="play">播放</button>${viewPodcast}${summary}${moreActions(secondaryActions, "action-menu-card")}</div>
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
      if (action === "transcribe") transcribeEpisodeAudio(item, control);
      if (action === "copy-episode") copyEpisodeLink(item);
      if (action === "copy-podcast") copyPodcastLink(item);
    });
  });
}

function renderSearchPage(root) {
  root.innerHTML = `
    <section><div class="route-eyebrow">SEARCH THE UNIVERSE</div><div class="search-bar"><input id="search-input" type="search" value="${esc(state.searchKeyword)}" placeholder="搜索节目、单集或主播" autocomplete="off" /><button id="search-submit" title="搜索">⌕</button></div>
    <div class="filter-row"><button class="filter-button" data-search-type="episode">单集</button><button class="filter-button" data-search-type="podcast">节目</button><button class="filter-button" data-search-type="user">用户</button></div><div id="search-results" class="result-list"></div></section>`;
  $$("[data-search-type]").forEach((button) => button.classList.toggle("is-active", button.dataset.searchType === state.searchType));
  $$("[data-search-type]").forEach((button) => button.addEventListener("click", () => {
    state.searchType = button.dataset.searchType;
    state.searchResults = null;
    $$("[data-search-type]").forEach((item) => item.classList.toggle("is-active", item === button));
    $("#search-results").innerHTML = `<div class="empty">输入关键词，搜索${button.textContent}。</div>`;
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
  const requestId = ++state.searchRequest;
  holder.innerHTML = `<div class="loading">正在搜索「${esc(keyword)}」……</div>`;
  try {
    const response = await api("/search", { keyword, type: state.searchType.toUpperCase() });
    if (requestId !== state.searchRequest) return;
    state.searchResults = listOf(response).map(itemOf).filter((item) => ["EPISODE", "PODCAST", "USER"].includes(item?.type));
    renderSearchResults(holder);
  } catch (error) {
    holder.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function renderSearchResults(holder) {
  if (state.searchResults === null) {
    holder.innerHTML = `<div class="empty">输入关键词，去找到下一段想听的声音。</div>`;
    return;
  }
  holder.innerHTML = state.searchResults.length
    ? state.searchResults.map((item, index) => searchResultRow(item, index)).join("")
    : `<div class="empty">没有找到相关结果。</div>`;
  bindSearchRows(holder, state.searchResults);
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
    canResolveEpisode ? `<button data-row-action="transcribe" role="menuitem">ASR 转写</button>` : "",
    episodeIdOf(item) ? `<button data-row-action="copy-episode" role="menuitem">复制单集链接</button>` : "",
    canViewPodcast ? `<button data-row-action="copy-podcast" role="menuitem">复制节目链接</button>` : ""
  ].join("");
  const actions = item?.type === "USER" ? "" : `
    <button class="row-action" data-row-action="play">播放</button>
    <button class="row-action" data-row-action="view-podcast" ${canViewPodcast ? "" : "disabled"}>查看节目</button>
    <button class="row-action is-primary" data-row-action="summarize">AI 总结</button>
    ${moreActions(secondaryActions, "action-menu-row")}`;
  return `<article class="episode-row" data-index="${index}">
    <div class="episode-thumb">${imageOf(item) ? `<img src="${esc(imageOf(item))}" alt="" />` : ""}</div>
    <div class="episode-meta"><strong>${esc(titleOf(item))}</strong><span>${esc(item?.podcast?.title || item?.podcast?.name || item?.description || (isPodcast ? "播客节目" : "小宇宙单集"))}</span></div>
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
    if (action === "play") openEpisode(item);
    if (action === "view-podcast") openPodcast(item);
    if (action === "summarize") summarizeEpisode(item, control).catch((error) => notify(error.message));
    if (action === "subscribe") toggleSubscription(item, control);
    if (action === "download") downloadEpisodeAudio(item);
    if (action === "transcribe") transcribeEpisodeAudio(item, control);
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
    `<button data-episode-action="transcribe" role="menuitem">ASR 转写</button>`,
    `<button data-episode-action="copy-episode" role="menuitem">复制单集链接</button>`,
    `<button data-episode-action="copy-podcast" role="menuitem">复制节目链接</button>`
  ].join("");
  return `<article class="episode-row podcast-episode-row" data-index="${index}">
    <div class="episode-thumb">${imageOf(episode) ? `<img src="${esc(imageOf(episode))}" alt="" />` : ""}</div>
    <div class="episode-meta"><strong>${esc(titleOf(episode))}</strong><span>${esc(publishedText)}</span></div>
    <div class="row-actions">
      <button class="row-action" data-episode-action="play">播放</button>
      <button class="row-action" data-episode-action="view-podcast">查看节目</button>
      <button class="row-action is-primary" data-episode-action="summarize">AI 总结</button>
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
    if (action === "transcribe") transcribeEpisodeAudio(episode, control);
  }));
}

function renderSettingsPage(root) {
  const settings = state.settings || {};
  const audioPath = String(settings.audioDownloadPath || "");
  const transcriptPath = String(settings.transcriptDownloadPath || "");
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
      <label>接口地址<input id="summary-${provider.id}-endpoint" type="url" value="${esc(config.endpoint || "")}" /></label>
      <label>模型<input id="summary-${provider.id}-model" type="text" value="${esc(config.model || "")}" /></label>
    </div>`;
  }).join("");
  root.innerHTML = `
    <section class="settings-page">
      <div class="section-heading"><h2>设置</h2><span>PREFERENCES</span></div>
      <form id="settings-form" class="settings-form">
        <section class="settings-section">
          <div class="settings-section-heading"><div><div class="route-eyebrow">DOWNLOADS</div><h3>下载设置</h3></div><p>音频以浏览器原始文件保存。</p></div>
          <label>音频保存目录
            <div class="path-input-row"><input id="audio-download-path" type="text" value="${esc(audioPath)}" placeholder="留空使用浏览器默认下载目录/小宇宙音频" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="audio-download-path">选择目录</button></div>
          </label>
          <p class="field-hint">实际位置：<code id="audio-path-preview"></code>。支持输入系统绝对路径或使用“选择目录”。</p>
          <label>ASR 转写稿保存目录
            <div class="path-input-row"><input id="transcript-download-path" type="text" value="${esc(transcriptPath)}" placeholder="留空使用浏览器默认下载目录/小宇宙转写稿" autocomplete="off" /><button type="button" class="secondary-button" data-choose-directory="transcript-download-path">选择目录</button></div>
          </label>
          <p class="field-hint">实际位置：<code id="transcript-path-preview"></code>。音频与转写稿目录互相独立。</p>
          <label class="checkbox-row"><input id="download-save-as" type="checkbox" ${settings.downloadSaveAs ? "checked" : ""} /><span>使用浏览器默认目录时，每次下载询问保存位置</span></label>
          <div id="native-host-status" class="native-host-status">正在检测本地文件助手……</div>
        </section>
        <section class="settings-section">
          <div class="settings-section-heading"><div><div class="route-eyebrow">CLOUD TRANSCRIPTION</div><h3>API 转写</h3></div><p>仅点击“ASR 转写”后发送音频。</p></div>
          <label>ASR 服务<select id="asr-provider"><option value="qwen">Qwen ASR</option><option value="doubao">豆包 ASR</option></select></label>
          <div class="provider-settings" data-asr-provider-settings="qwen">
            <label>Qwen API Key<input id="qwen-api-key" type="password" placeholder="已保存则留空；输入新值会覆盖" autocomplete="new-password" /></label>
            <label>接口地址<input id="qwen-asr-endpoint" type="url" value="${esc(settings.qwenAsrEndpoint || "")}" /></label>
            <label>模型<input id="qwen-asr-model" type="text" value="${esc(settings.qwenAsrModel || "qwen-audio-3.0-asr-flash-filetrans")}" /></label>
          </div>
          <div class="provider-settings" data-asr-provider-settings="doubao">
            <label>豆包 API Key<input id="doubao-api-key" type="password" placeholder="已保存则留空；输入新值会覆盖" autocomplete="new-password" /></label>
            <label>接口地址<input id="doubao-asr-endpoint" type="url" value="${esc(settings.doubaoAsrEndpoint || "")}" /></label>
            <label>Resource ID<input id="doubao-asr-resource-id" type="text" value="${esc(settings.doubaoAsrResourceId || "volc.bigasr.auc_turbo")}" /></label>
          </div>
          <div id="asr-provider-status" class="native-host-status">正在检查 API 配置……</div>
          <p class="field-hint">API Key 由 Native Host 保存在 macOS Keychain，扩展不会回显完整密钥。转写会将音频 URL 或音频内容发送至所选服务。</p>
        </section>
        <section class="settings-section summary-settings-section">
          <div class="settings-section-heading"><div><div class="route-eyebrow">AI SUMMARY</div><h3>AI 总结</h3></div><p>主动触发后发送转写稿，输出独立 Markdown。</p></div>
          <label>总结服务<select id="summary-provider">${summaryProviderOptions}</select></label>
          ${summaryProviderPanels}
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
        <section class="settings-section">
          <div class="settings-section-heading"><div><div class="route-eyebrow">CONNECTION</div><h3>连接设置</h3></div><p>默认通过扩展 Service Worker 直连。</p></div>
          <label>请求模式<select id="api-mode"><option value="direct">扩展直连（本地开发）</option><option value="proxy">受控代理（生产推荐）</option></select></label>
          <label>代理地址<input id="proxy-url" type="url" value="${esc(settings.proxyBaseUrl || "")}" placeholder="https://your-proxy.example.com" /></label>
          <p class="field-hint">请勿将代理地址指向不可信服务。</p>
        </section>
        <button class="primary-button settings-save" type="submit">保存设置</button>
      </form>
    </section>`;
  $("#api-mode").value = settings.apiMode || "direct";
  $("#asr-provider").value = settings.asrProvider || "qwen";
  const updateAsrProviderSettings = () => {
    $$("[data-asr-provider-settings]").forEach((node) => {
      node.hidden = node.dataset.asrProviderSettings !== $("#asr-provider").value;
    });
  };
  updateAsrProviderSettings();
  $("#asr-provider").addEventListener("change", updateAsrProviderSettings);
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
    $("#audio-path-preview").textContent = audioValue || "浏览器默认下载目录/小宇宙音频";
    $("#transcript-path-preview").textContent = transcriptValue || "浏览器默认下载目录/小宇宙转写稿";
    $("#download-save-as").disabled = Boolean(audioValue);
  };
  updatePreview();
  $("#audio-download-path").addEventListener("input", updatePreview);
  $("#transcript-download-path").addEventListener("input", updatePreview);
  $$("[data-choose-directory]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const prompt = button.dataset.chooseDirectory === "audio-download-path" ? "请选择音频保存目录" : "请选择 ASR 转写稿保存目录";
      const data = await send("choose-native-directory", { prompt });
      $(`#${button.dataset.chooseDirectory}`).value = data.path;
      updatePreview();
    } catch (error) {
      notify(error.message);
    }
  }));
  $$("[data-clear-summary-key]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("确认从 macOS Keychain 删除这个 AI 总结 API Key？")) return;
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
    const node = $("#native-host-status");
    if (!node) return;
    node.classList.toggle("is-ready", status.available);
    node.textContent = status.available
      ? `本地文件助手已连接 · ${status.version || "可用"}`
      : `本地文件助手未连接，绝对路径不可用。${status.error || ""}`;
    const providerNode = $("#asr-provider-status");
    if (!providerNode) return;
    providerNode.classList.toggle("is-ready", status.qwenConfigured || status.doubaoConfigured);
    providerNode.textContent = `Qwen：${status.qwenConfigured ? "已配置" : "未配置"} · 豆包：${status.doubaoConfigured ? "已配置" : "未配置"}`;
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
  $("#download-audio-button").disabled = !hasAudio;
  $("#transcribe-audio-button").disabled = !hasAudio;
  $("#summarize-button").disabled = !hasAudio;
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
  if (eid && !audioOf(episode)) {
    episode = unwrapDetail(await api("/episode_detail", { eid }));
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
    const providerLabel = state.settings?.asrProvider === "doubao" ? "豆包" : "Qwen";
    setTranscriptionStatus(`${providerLabel} 长音频转写中，请保持窗口打开`);
    notify(`${providerLabel} ASR 正在转写，请保持窗口打开`);
    const filename = audioFilenameOf(episode);
    const result = await send("transcribe-audio", {
      payload: {
        url: audio,
        filename,
        baseName: filename.replace(/\.[^.]+$/, ""),
        language: "zh"
      }
    });
    const transcriptPath = result.markdown || result.md || result.txt;
    if (!transcriptPath) throw new Error("ASR 完成但未返回转写稿路径");
    state.currentTranscriptPath = transcriptPath;
    state.currentTranscriptEpisodeId = episodeIdOf(episode);
    state.currentSummaryPath = "";
    setTranscriptionStatus(`转写完成：${transcriptPath}`, "success");
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

function summaryProviderLabel(providerId = state.settings?.summaryProvider) {
  return SUMMARY_PROVIDERS.find((provider) => provider.id === providerId)?.label || providerId || "AI Provider";
}

function ensureSummaryConsent() {
  if (state.settings?.summaryConsentAccepted) return Promise.resolve(true);
  const dialog = $("#summary-consent-dialog");
  $("#summary-consent-provider").textContent = summaryProviderLabel();
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

async function summarizeTranscriptPath(
  transcriptPath,
  button = null,
  statusNode = null,
  { skipConsent = false } = {}
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
      payload: { transcriptPath }
    });
    const summaryPath = result.markdown;
    if (!summaryPath) throw new Error("AI 总结完成但未返回 Markdown 路径");
    state.currentSummaryPath = summaryPath;
    if (statusNode) statusNode.textContent = `总结完成：${summaryPath}`;
    setTranscriptionStatus(`AI 总结完成：${summaryPath}`, "success");
    notify(`AI 总结完成：${summaryPath}`);
    return result;
  } catch (error) {
    if (statusNode) statusNode.textContent = `总结失败：${error.message}`;
    setTranscriptionStatus(`AI 总结失败：${error.message}`, "error");
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function summarizeEpisode(item, button = null) {
  if (!await ensureSummaryConsent()) return null;
  const episode = await resolveEpisode(item);
  const eid = episodeIdOf(episode);
  if (!eid || !audioOf(episode)) throw new Error("这集暂时没有可总结的音频");
  const hasMatchingTranscript = (
    state.currentTranscriptPath
    && state.currentTranscriptEpisodeId === eid
  );
  const transcriptPath = hasMatchingTranscript
    ? state.currentTranscriptPath
    : await transcribeEpisodeAudio(episode, button, { propagate: true });
  return summarizeTranscriptPath(
    transcriptPath,
    button,
    null,
    { skipConsent: true }
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
    }
    state.currentSummaryPath = "";
    setTranscriptionStatus();
    updatePlayerLinkButtons(episode);
    const player = $("#audio");
    player.src = audio;
    $("#player-title").textContent = titleOf(episode);
    $("#player-subtitle").textContent = episode?.podcast?.title || episode?.podcast?.name || "小宇宙单集";
    const image = imageOf(episode);
    $("#player-cover").innerHTML = image ? `<img src="${esc(image)}" alt="" />` : "<span>◌</span>";
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

function openLogin() { $("#login-error").textContent = ""; $("#login-dialog").showModal(); }

async function submitLogin(event) {
  event.preventDefault();
  const errorNode = $("#login-error");
  errorNode.textContent = "";
  const phone = $("#phone-input").value.trim();
  const code = $("#code-input").value.trim();
  if (!phone || !code) return;
  try {
    state.auth = await send("login", { payload: { mobilePhoneNumber: phone, verifyCode: code, areaCode: "+86" } });
    markConnection(); $("#login-dialog").close(); notify("登录成功"); renderRoute();
  } catch (error) { errorNode.textContent = error.message; }
}

async function sendCode() {
  const phone = $("#phone-input").value.trim();
  if (!phone) return $("#login-error").textContent = "请先填写手机号";
  const button = $("#send-code-button");
  button.disabled = true;
  try { await send("send-code", { payload: { mobilePhoneNumber: phone, areaCode: "+86" } }); notify("验证码已发送"); } catch (error) { $("#login-error").textContent = error.message; } finally { setTimeout(() => { button.disabled = false; }, 30000); }
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
    state.settings = await send("update-settings", {
      settings: {
        apiMode: $("#api-mode").value,
        proxyBaseUrl: $("#proxy-url").value.trim(),
        downloadFolder: "小宇宙音频",
        transcriptFolder: "小宇宙转写稿",
        audioDownloadPath: $("#audio-download-path").value.trim(),
        transcriptDownloadPath: $("#transcript-download-path").value.trim(),
        downloadSaveAs: $("#download-save-as").checked,
        asrProvider: $("#asr-provider").value,
        qwenAsrEndpoint: $("#qwen-asr-endpoint").value.trim(),
        qwenAsrModel: $("#qwen-asr-model").value.trim(),
        doubaoAsrEndpoint: $("#doubao-asr-endpoint").value.trim(),
        doubaoAsrResourceId: $("#doubao-asr-resource-id").value.trim(),
        summaryProvider: $("#summary-provider").value,
        summaryProviders,
        summaryPromptVersions: state.summaryPromptDrafts.map((prompt) => ({ ...prompt })),
        activeSummaryPromptId: state.settings.activeSummaryPromptId,
        summaryConsentAccepted: Boolean(state.settings.summaryConsentAccepted)
      }
    });
    $("#qwen-api-key").value = "";
    $("#doubao-api-key").value = "";
    SUMMARY_PROVIDERS.forEach((provider) => {
      $(`#summary-${provider.id}-api-key`).value = "";
    });
    const providerNode = $("#asr-provider-status");
    if (providerNode) {
      providerNode.classList.toggle("is-ready", asrCredentialStatus.qwenConfigured || asrCredentialStatus.doubaoConfigured);
      providerNode.textContent = `Qwen：${asrCredentialStatus.qwenConfigured ? "已配置" : "未配置"} · 豆包：${asrCredentialStatus.doubaoConfigured ? "已配置" : "未配置"}`;
    }
    renderSummaryProviderStatus(summaryCredentialStatus.summaryConfigured || {});
    $("#audio-download-path").value = state.settings.audioDownloadPath;
    $("#transcript-download-path").value = state.settings.transcriptDownloadPath;
    $("#audio-path-preview").textContent = state.settings.audioDownloadPath || "浏览器默认下载目录/小宇宙音频";
    $("#transcript-path-preview").textContent = state.settings.transcriptDownloadPath || "浏览器默认下载目录/小宇宙转写稿";
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
    return state.current ? transcribeEpisodeAudio(state.current, event.currentTarget) : notify("当前没有正在播放的单集");
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
  audio.addEventListener("play", () => { $("#play-button").textContent = "Ⅱ"; });
  audio.addEventListener("pause", () => { $("#play-button").textContent = "▶"; });
  audio.addEventListener("loadedmetadata", () => { $("#duration").textContent = formatTime(audio.duration); });
  audio.addEventListener("timeupdate", () => { $("#current-time").textContent = formatTime(audio.currentTime); $("#progress").value = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0; });
  $("#progress").addEventListener("input", (event) => { if (audio.duration) audio.currentTime = (event.target.value / 100) * audio.duration; });
}

async function init() {
  [state.auth, state.settings] = await Promise.all([send("get-auth"), send("get-settings")]);
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  $("#back-button").hidden = true;
  markConnection(); initPlayer(); renderRoute();
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => setRoute(item.dataset.route)));
  $("#back-button").addEventListener("click", closePodcast);
  $("#sidebar-toggle").addEventListener("click", () => setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed")));
  $("#account-button").addEventListener("click", () => state.auth ? send("logout").then(() => { state.auth = null; markConnection(); renderRoute(); notify("已退出登录"); }) : openLogin());
  $("#login-form").addEventListener("submit", submitLogin); $("#send-code-button").addEventListener("click", sendCode);
  $$("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  document.addEventListener("click", (event) => {
    const activeMenu = event.target.closest(".action-menu");
    $$(".action-menu[open]").forEach((menu) => {
      if (menu !== activeMenu) menu.removeAttribute("open");
    });
  });
}

init().catch((error) => notify(error.message));
