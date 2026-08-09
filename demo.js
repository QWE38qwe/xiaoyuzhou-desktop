const podcasts = [
  {
    id: "city",
    title: "城市漫游指南",
    author: "漫游编辑部",
    description: "在街角、建筑与日常里重新认识城市。每一期跟随一位当地观察者，寻找地图之外的生活线索。",
    cover: "cover-yellow",
    episodes: [
      { title: "在凌晨四点寻找一座城市", date: "2026/08/01", duration: "42:18" },
      { title: "菜市场里的空间设计", date: "2026/07/24", duration: "36:42" },
      { title: "一条河如何改变社区", date: "2026/07/12", duration: "51:06" }
    ]
  },
  {
    id: "tech",
    title: "技术与人",
    author: "边界电台",
    description: "关注技术如何进入普通人的工作、生活与选择，不追逐名词，只讨论真实改变。",
    cover: "cover-cyan",
    episodes: [
      { title: "AI 工具如何进入日常工作流", date: "2026/08/08", duration: "48:20" },
      { title: "为什么本地优先重新重要", date: "2026/07/28", duration: "40:12" },
      { title: "把复杂系统解释给所有人", date: "2026/07/16", duration: "44:35" }
    ]
  },
  {
    id: "alone",
    title: "独处练习",
    author: "缓慢发生",
    description: "记录安静、注意力与个人空间，寻找不被效率定义的生活节奏。",
    cover: "cover-coral",
    episodes: [
      { title: "我们为什么需要独处", date: "2026/08/05", duration: "39:16" },
      { title: "让一天慢下来的方法", date: "2026/07/19", duration: "33:28" },
      { title: "重新学习专注", date: "2026/07/02", duration: "46:03" }
    ]
  },
  {
    id: "sound",
    title: "声音采集计划",
    author: "现场档案",
    description: "用声音保存正在消失的地点、职业与记忆。",
    cover: "cover-green",
    episodes: [
      { title: "清晨六点的渡口", date: "2026/08/03", duration: "31:40" },
      { title: "修表师傅的工作台", date: "2026/07/21", duration: "37:09" }
    ]
  },
  {
    id: "book",
    title: "纸上远行",
    author: "页间工作室",
    description: "从一本书出发，追踪思想在不同时间和地域里的回声。",
    cover: "cover-ink",
    episodes: [
      { title: "一张地图的两种读法", date: "2026/08/06", duration: "52:10" },
      { title: "重读日常生活", date: "2026/07/25", duration: "45:37" }
    ]
  }
];

const routeMeta = {
  discover: ["EXPLORE", "发现"],
  search: ["FIND YOUR NEXT STORY", "搜索"],
  subscriptions: ["YOUR LIBRARY", "我的订阅"],
  settings: ["PREFERENCES", "设置"]
};

const state = {
  route: "discover",
  currentPodcast: podcasts[1],
  currentEpisode: podcasts[1].episodes[0],
  playing: false,
  speed: 1,
  subscribed: new Set(["tech", "city"]),
  pipelineRunning: false
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("is-visible"), 2200);
}

function cardTemplate(podcast) {
  return `
    <article class="podcast-card" data-podcast="${podcast.id}">
      <div class="cover ${podcast.cover}" data-action="detail"><span>PODCAST</span></div>
      <div class="card-copy">
        <strong>${podcast.title}</strong>
        <span>${podcast.author}</span>
      </div>
      <div class="card-actions">
        <button class="mini-button" data-action="play">播放</button>
        <button class="mini-button" data-action="detail">查看节目</button>
        <button class="mini-button ${state.subscribed.has(podcast.id) ? "accent" : ""}" data-action="subscribe">
          ${state.subscribed.has(podcast.id) ? "已订阅" : "订阅"}
        </button>
      </div>
    </article>
  `;
}

function episodeTemplate(episode, podcast, index) {
  return `
    <div class="episode-row">
      <div class="episode-thumb ${podcast.cover}"></div>
      <div class="episode-meta">
        <strong>${episode.title}</strong>
        <span>${episode.date} · ${episode.duration}</span>
      </div>
      <div class="row-actions">
        <button class="row-button" data-episode="${index}" data-podcast="${podcast.id}" data-action="transcribe">ASR</button>
        <button class="row-button" data-episode="${index}" data-podcast="${podcast.id}" data-action="summarize">AI 总结</button>
        <button class="row-play" data-episode="${index}" data-podcast="${podcast.id}" data-action="play">▶</button>
      </div>
    </div>
  `;
}

function renderDiscover() {
  $("#page-content").innerHTML = `
    <section class="hero">
      <div>
        <span class="eyebrow">THE DAILY FREQUENCY</span>
        <h1>今天，听点<br>不一样的。</h1>
        <p>从精选节目、热门单集和你可能喜欢的声音里，挑一段刚好适合此刻的陪伴。</p>
      </div>
      <div class="hero-art" aria-hidden="true"></div>
    </section>
    <div class="section-heading">
      <h2>为你精选</h2>
      <span>CURATED FOR YOU</span>
    </div>
    <section class="feed-grid">${podcasts.slice(0, 3).map(cardTemplate).join("")}</section>
    <div class="section-heading" style="margin-top:38px">
      <h2>继续探索</h2>
      <span>MORE FREQUENCIES</span>
    </div>
    <section class="feed-grid">${podcasts.slice(3).map(cardTemplate).join("")}</section>
  `;
  bindCardActions();
}

function renderSearch() {
  $("#page-content").innerHTML = `
    <section class="search-shell">
      <div class="search-intro">
        <span class="eyebrow">SEARCH THE ARCHIVE</span>
        <h1>下一段故事，<br>从一个词开始。</h1>
        <p>试试“AI”“城市”或“独处”。</p>
      </div>
      <form class="search-bar">
        <input id="search-input" value="AI" aria-label="搜索关键词">
        <button type="submit" aria-label="搜索">⌕</button>
      </form>
      <div id="search-results" class="episode-list"></div>
    </section>
  `;
  const renderResults = () => {
    const keyword = $("#search-input").value.trim().toLowerCase();
    const results = podcasts.flatMap((podcast) =>
      podcast.episodes
        .map((episode, index) => ({ podcast, episode, index }))
        .filter(({ podcast, episode }) =>
          !keyword ||
          podcast.title.toLowerCase().includes(keyword) ||
          episode.title.toLowerCase().includes(keyword)
        )
    );
    $("#search-results").innerHTML = results.length
      ? results.map(({ podcast, episode, index }) => episodeTemplate(episode, podcast, index)).join("")
      : `<div class="provider-note">没有匹配结果。试试“城市”或“独处”。</div>`;
    bindEpisodeActions();
  };
  $(".search-bar").addEventListener("submit", (event) => {
    event.preventDefault();
    renderResults();
  });
  renderResults();
}

function renderSubscriptions() {
  const items = podcasts.filter((podcast) => state.subscribed.has(podcast.id));
  $("#page-content").innerHTML = `
    <section class="hero">
      <div>
        <span class="eyebrow">YOUR LIBRARY</span>
        <h1>留在这里的，<br>都是想再听的。</h1>
        <p>演示订阅保存在当前页面状态中，刷新后会恢复为默认数据。</p>
      </div>
      <div class="hero-art" style="background:var(--coral)"></div>
    </section>
    <div class="section-heading"><h2>我的订阅</h2><span>${items.length} SHOWS</span></div>
    <section class="feed-grid">${items.map(cardTemplate).join("")}</section>
  `;
  bindCardActions();
}

function renderSettings() {
  $("#page-content").innerHTML = `
    <section class="settings-page">
      <span class="eyebrow">LOCAL FIRST · CLOUD READY</span>
      <h1>处理方式，由你决定。</h1>
      <p class="settings-lead">此页面只展示配置能力，不会保存输入或连接真实服务。</p>

      <section class="settings-section">
        <div class="settings-heading">
          <div><span class="eyebrow">FILE OUTPUT</span><h2>本地保存</h2></div>
          <p>音频、转写稿与 AI 总结稿可以分别保存到 macOS 绝对路径。</p>
        </div>
        <label>音频保存目录<input value="~/Downloads/小宇宙音频" readonly></label>
        <label>转写稿保存目录<input value="~/Downloads/小宇宙转写稿" readonly></label>
      </section>

      <section class="settings-section">
        <div class="settings-heading">
          <div><span class="eyebrow">TRANSCRIPTION</span><h2>ASR 转写</h2></div>
          <p>本地模式不外发音频；API 模式适合低内存设备和长音频任务。</p>
        </div>
        <label>ASR 服务
          <select id="asr-select">
            <option>本地 Qwen3-ASR</option>
            <option>Qwen API</option>
            <option>豆包 API</option>
          </select>
        </label>
        <div id="provider-note" class="provider-note">本地运行时已安装 · Qwen3-ASR 0.6B 已缓存 · 任务结束自动释放内存</div>
      </section>

      <section class="settings-section blue">
        <div class="settings-heading">
          <div><span class="eyebrow">AI SUMMARY</span><h2>结构化总结</h2></div>
          <p>兼容五家 Provider，支持 Prompt 版本和长文本分段总结。</p>
        </div>
        <div class="capability-grid">
          <div class="capability"><i>01</i><strong>自动前序流程</strong><span>没有转写稿时，自动执行 ASR → 总结。</span></div>
          <div class="capability"><i>02</i><strong>Prompt 版本</strong><span>内置结构化模板，也可复制为自定义版本。</span></div>
          <div class="capability"><i>03</i><strong>Keychain</strong><span>API Key 由本地助手保存到 macOS Keychain。</span></div>
        </div>
      </section>
    </section>
  `;
  $("#asr-select").addEventListener("change", (event) => {
    const notes = {
      "本地 Qwen3-ASR": "本地运行时已安装 · Qwen3-ASR 0.6B 已缓存 · 任务结束自动释放内存",
      "Qwen API": "长音频模型 · qwen-audio-3.0-asr-flash-filetrans · 异步轮询",
      "豆包 API": "云端转写 · 部分格式由 Native Host 调用 ffmpeg 转换"
    };
    $("#provider-note").textContent = notes[event.target.value];
  });
}

function renderDetail(podcast) {
  state.currentPodcast = podcast;
  state.route = "detail";
  $("#route-eyebrow").textContent = "PROGRAM ARCHIVE";
  $("#route-title").textContent = podcast.title;
  $("#back-button").hidden = false;
  $("#page-content").innerHTML = `
    <section class="detail-hero">
      <div class="detail-cover cover ${podcast.cover}"><span>PODCAST</span></div>
      <div class="detail-copy">
        <span class="eyebrow">PODCAST ARCHIVE</span>
        <h1>${podcast.title}</h1>
        <p class="detail-author">${podcast.author}</p>
        <p>${podcast.description}</p>
        <div class="detail-actions">
          <button class="primary-button" id="detail-subscribe">${state.subscribed.has(podcast.id) ? "已订阅节目" : "订阅节目"}</button>
          <button class="secondary-button" id="detail-copy">复制节目链接</button>
        </div>
      </div>
    </section>
    <div class="section-heading"><h2>全部单集</h2><span>EPISODE ARCHIVE</span></div>
    <section class="episode-list">
      ${podcast.episodes.map((episode, index) => episodeTemplate(episode, podcast, index)).join("")}
    </section>
  `;
  $("#detail-subscribe").addEventListener("click", () => toggleSubscription(podcast));
  $("#detail-copy").addEventListener("click", () => notify("演示节目链接已复制"));
  bindEpisodeActions();
}

function setRoute(route) {
  state.route = route;
  const [eyebrow, title] = routeMeta[route];
  $("#route-eyebrow").textContent = eyebrow;
  $("#route-title").textContent = title;
  $("#back-button").hidden = true;
  $$(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.route === route));
  ({
    discover: renderDiscover,
    search: renderSearch,
    subscriptions: renderSubscriptions,
    settings: renderSettings
  })[route]();
}

function toggleSubscription(podcast) {
  if (state.subscribed.has(podcast.id)) {
    state.subscribed.delete(podcast.id);
    notify(`已取消订阅「${podcast.title}」`);
  } else {
    state.subscribed.add(podcast.id);
    notify(`已订阅「${podcast.title}」`);
  }
  if (state.route === "detail") renderDetail(podcast);
  else setRoute(state.route);
}

function playEpisode(podcast, episode) {
  state.currentPodcast = podcast;
  state.currentEpisode = episode;
  state.playing = true;
  $("#player-title").textContent = episode.title;
  $("#player-subtitle").textContent = `${podcast.title} · 正在播放`;
  $("#player-cover").className = `player-cover ${podcast.cover}`;
  $("#player-cover").innerHTML = "<span>▶</span>";
  $("#play-button").textContent = "Ⅱ";
  $("#progress").value = 8;
  $("#current-time").textContent = "3:48";
  $("#duration").textContent = episode.duration;
  notify(`正在播放：${episode.title}`);
}

function bindCardActions() {
  $$("[data-podcast]").forEach((card) => {
    const podcast = podcasts.find((item) => item.id === card.dataset.podcast);
    card.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (!action) return;
      if (action === "detail") renderDetail(podcast);
      if (action === "play") playEpisode(podcast, podcast.episodes[0]);
      if (action === "subscribe") toggleSubscription(podcast);
    });
  });
}

function bindEpisodeActions() {
  $$("[data-episode]").forEach((button) => {
    button.addEventListener("click", () => {
      const podcast = podcasts.find((item) => item.id === button.dataset.podcast);
      const episode = podcast.episodes[Number(button.dataset.episode)];
      if (button.dataset.action === "play") playEpisode(podcast, episode);
      if (button.dataset.action === "transcribe") {
        state.currentPodcast = podcast;
        state.currentEpisode = episode;
        runPipeline(false);
      }
      if (button.dataset.action === "summarize") {
        state.currentPodcast = podcast;
        state.currentEpisode = episode;
        runPipeline(true);
      }
    });
  });
}

function resetPipeline() {
  $$("#pipeline > div").forEach((node) => {
    node.className = "";
    $("b", node).textContent = "等待";
  });
  $("#pipeline").hidden = false;
  $("#summary-result").hidden = true;
}

async function runPipeline(includeSummary = true) {
  if (state.pipelineRunning) return;
  state.pipelineRunning = true;
  resetPipeline();
  $("#summary-title").textContent = includeSummary ? "正在整理这一期" : "正在生成转写稿";
  $("#summary-lead").textContent = includeSummary
    ? "模拟执行 ASR → 分段总结 → Markdown 归档"
    : "模拟执行本地 Qwen3-ASR → Markdown 归档";
  $("#summary-dialog").showModal();
  const steps = includeSummary
    ? ["audio", "asr", "summary", "markdown"]
    : ["audio", "asr", "markdown"];

  for (const step of steps) {
    const node = $(`[data-step="${step}"]`);
    node.classList.add("is-active");
    $("b", node).textContent = step === "asr" ? "本地处理中" : "处理中";
    $("#pipeline-status").textContent = `${$("span", node).textContent}…`;
    await new Promise((resolve) => setTimeout(resolve, step === "asr" ? 900 : 650));
    node.classList.remove("is-active");
    node.classList.add("is-done");
    $("b", node).textContent = "完成";
  }

  if (!includeSummary) {
    $("#pipeline-status").textContent = "ASR 转写完成 · Markdown 已保存";
    notify("演示转写稿已生成");
    state.pipelineRunning = false;
    return;
  }
  $("#pipeline").hidden = true;
  $("#summary-result").hidden = false;
  $("#summary-title").textContent = "总结已完成";
  $("#summary-lead").textContent = "4 个步骤全部在演示环境中完成";
  $("#pipeline-status").textContent = "AI 总结完成 · Markdown 已归档";
  state.pipelineRunning = false;
}

function setupGlobalActions() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setRoute(button.dataset.route)));
  $("#back-button").addEventListener("click", () => setRoute("discover"));
  $("#sidebar-toggle").addEventListener("click", () => {
    document.body.classList.toggle("sidebar-collapsed");
    const collapsed = document.body.classList.contains("sidebar-collapsed");
    $("#sidebar-toggle").textContent = collapsed ? "›" : "‹";
    $("#sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
  });
  $("#play-button").addEventListener("click", () => {
    state.playing = !state.playing;
    $("#play-button").textContent = state.playing ? "Ⅱ" : "▶";
  });
  $("#skip-back").addEventListener("click", () => {
    $("#progress").value = Math.max(0, Number($("#progress").value) - 5);
    notify("已后退 15 秒");
  });
  $("#skip-forward").addEventListener("click", () => {
    $("#progress").value = Math.min(100, Number($("#progress").value) + 8);
    notify("已前进 30 秒");
  });
  $("#progress").addEventListener("input", (event) => {
    const total = 48 * 60 + 20;
    const seconds = Math.floor(total * Number(event.target.value) / 100);
    $("#current-time").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  });
  $("#view-podcast").addEventListener("click", () => renderDetail(state.currentPodcast));
  $("#summarize").addEventListener("click", () => runPipeline(true));
  $("#transcribe-demo").addEventListener("click", () => runPipeline(false));
  $("#download-demo").addEventListener("click", () => notify("演示模式不会下载真实音频"));
  $("#copy-demo").addEventListener("click", () => notify("演示单集链接已复制"));
  $("#speed-demo").addEventListener("click", () => {
    state.speed = state.speed === 2 ? 1 : state.speed + 0.5;
    $("#speed-demo").textContent = `播放速度 · ${state.speed}×`;
    notify(`播放速度已调整为 ${state.speed}×`);
  });
  $("#demo-help").addEventListener("click", () => $("#help-dialog").showModal());
  $$(".dialog-close").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("#copy-summary").addEventListener("click", async () => {
    const markdown = `# AI 工具如何进入日常工作流\n\n> AI 的价值不在于替代完整工作，而在于缩短信息整理、初稿生成与验证之间的距离。\n\n## 核心结论\n- 从高频、低风险、结果可检查的任务开始。\n- 模型输出应进入人工校验闭环。\n- 本地处理与云端能力按隐私敏感度分层选择。`;
    try { await navigator.clipboard.writeText(markdown); } catch {}
    notify("Markdown 已复制");
  });
}

setupGlobalActions();
renderDiscover();
