const WINDOW_KEY = "desktopWindowId";
const BOUNDS_KEY = "desktopWindowBounds";
const AUTH_KEY = "xyzAuth";
const SETTINGS_KEY = "xyzSettings";
const NATIVE_HOST = "com.xiaoyuzhou.desktop";
const ASR_SETTINGS_VERSION = 2;

const DEFAULT_BOUNDS = { width: 480, height: 900 };
const DEFAULT_SETTINGS = {
  apiMode: "direct",
  proxyBaseUrl: "",
  downloadFolder: "小宇宙音频",
  transcriptFolder: "小宇宙转写稿",
  audioDownloadPath: "",
  transcriptDownloadPath: "",
  downloadSaveAs: false,
  asrProvider: "qwen",
  asrSettingsVersion: ASR_SETTINGS_VERSION,
  qwenAsrEndpoint: "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription",
  qwenAsrModel: "qwen-audio-3.0-asr-flash-filetrans",
  doubaoAsrEndpoint: "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash",
  doubaoAsrResourceId: "volc.bigasr.auc_turbo",
  autoplay: true,
  theme: "light"
};

const UPSTREAM = {
  api: "https://api.xiaoyuzhoufm.com",
  auth: "https://podcaster-api.xiaoyuzhoufm.com"
};

const API_ENDPOINTS = {
  "/discovery": "/v1/discovery-feed/list",
  "/editor_pick": "/v1/editor-pick/list",
  "/top_list": "/v1/top-list/get",
  "/search": "/v1/search/create",
  "/episode_detail": "/v1/episode/get",
  "/episode_list": "/v1/episode/list",
  "/subscription": "/v1/subscription/list",
  "/subscription_update": "/v1/subscription/update"
};

const APP_HEADERS = {
  "Accept": "*/*",
  "Accept-Language": "zh-Hans-CN,zh-Hant-TW;q=0.9,en;q=0.8",
  "Connection": "keep-alive",
  "App-BuildNo": "1576",
  "App-Version": "2.57.1",
  "BundleID": "app.podcast.cosmos",
  "Content-Type": "application/json",
  "Market": "AppStore",
  "Manufacturer": "Apple",
  "Model": "iPhone14,2",
  "OS": "ios",
  "OS-Version": "17.4.1",
  "User-Agent": "Xiaoyuzhou/2.57.1 (build:1576; iOS 17.4.1)",
  "WifiConnected": "true",
  "abtest-info": "{\"old_user_discovery_feed\":\"enable\"}",
  "app-permissions": "4",
  "x-custom-xiaoyuzhou-app-dev": ""
};

async function getSettings() {
  const { [SETTINGS_KEY]: settings = {} } = await chrome.storage.local.get(SETTINGS_KEY);
  if ((settings.asrSettingsVersion || 0) < ASR_SETTINGS_VERSION) {
    const migrated = {
      ...settings,
      asrSettingsVersion: ASR_SETTINGS_VERSION,
      qwenAsrEndpoint: DEFAULT_SETTINGS.qwenAsrEndpoint,
      qwenAsrModel: DEFAULT_SETTINGS.qwenAsrModel
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: migrated });
    return { ...DEFAULT_SETTINGS, ...migrated };
  }
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function getAuth() {
  const { [AUTH_KEY]: auth = null } = await chrome.storage.local.get(AUTH_KEY);
  return auth;
}

async function saveAuth(auth) {
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
  return auth;
}

async function authWithDeviceId(auth) {
  if (!auth?.accessToken || auth.deviceId) return auth;
  const next = { ...auth, deviceId: crypto.randomUUID() };
  return saveAuth(next);
}

async function clearAuth() {
  await chrome.storage.local.remove(AUTH_KEY);
}

function sanitizeBounds(bounds = {}) {
  const clean = { ...DEFAULT_BOUNDS };
  if (Number.isFinite(bounds.width)) clean.width = Math.max(380, Math.min(900, bounds.width));
  if (Number.isFinite(bounds.height)) clean.height = Math.max(680, Math.min(1200, bounds.height));
  if (Number.isFinite(bounds.left)) clean.left = bounds.left;
  if (Number.isFinite(bounds.top)) clean.top = bounds.top;
  return clean;
}

async function storedWindow() {
  const { [WINDOW_KEY]: windowId } = await chrome.storage.session.get(WINDOW_KEY);
  if (!Number.isInteger(windowId)) return null;
  try {
    return await chrome.windows.get(windowId, { populate: true });
  } catch {
    await chrome.storage.session.remove(WINDOW_KEY);
    return null;
  }
}

async function openAppWindow() {
  const existing = await storedWindow();
  if (existing) {
    await chrome.windows.update(existing.id, { focused: true });
    return existing;
  }

  const { [BOUNDS_KEY]: savedBounds } = await chrome.storage.local.get(BOUNDS_KEY);
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL("app.html"),
    type: "popup",
    focused: true,
    ...sanitizeBounds(savedBounds)
  });
  if (Number.isInteger(created.id)) await chrome.storage.session.set({ [WINDOW_KEY]: created.id });
  return created;
}

function upstreamUrl(path) {
  const root = path.startsWith("/v1/auth/") ? UPSTREAM.auth : UPSTREAM.api;
  return `${root}${path.replace(/^\/auth/, "")}`;
}

function proxyUrl(base, path) {
  return `${base.replace(/\/$/, "")}${path}`;
}

function withAppHeaders(auth, extra = {}) {
  return {
    ...APP_HEADERS,
    "Local-Time": new Date().toISOString(),
    "Timezone": "Asia/Shanghai",
    ...(auth?.accessToken ? { "x-jike-access-token": auth.accessToken } : {}),
    ...(auth?.deviceId ? { "x-jike-device-id": auth.deviceId } : {}),
    ...extra
  };
}

function safeDownloadFilename(filename) {
  const fallback = "xiaoyuzhou-audio.m4a";
  const clean = String(filename || fallback)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? clean.slice(0, 180) : fallback;
}

function normalizeDownloadFolder(folder) {
  const value = String(folder ?? "").trim().replace(/\\/g, "/");
  if (!value) return "";
  if (value.startsWith("/") || /^[a-zA-Z]:\//.test(value)) {
    throw new Error("浏览器回退子目录必须使用相对路径");
  }
  const parts = value.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error("下载目录不能包含 . 或 ..");
  }
  return parts.map((part) => part.replace(/[\\/:*?"<>|]/g, "_").trim()).filter(Boolean).join("/");
}

function normalizeAbsolutePath(path, label) {
  const value = String(path ?? "").trim();
  if (!value) return "";
  if (!value.startsWith("/") && !value.startsWith("~/")) {
    throw new Error(`${label}必须是系统绝对路径`);
  }
  return value.replace(/\/+$/, "") || "/";
}

function nativeHostRequest(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`本地助手不可用：${chrome.runtime.lastError.message}`));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "本地助手执行失败"));
        return;
      }
      resolve(response.data);
    });
  });
}

async function getNativeHostStatus() {
  try {
    const data = await nativeHostRequest({ action: "ping" });
    return { available: true, ...data };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

async function downloadAudio({ url, filename }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("音频地址无效");
  }
  if (parsed.protocol !== "https:") throw new Error("只支持下载 HTTPS 音频");
  const settings = await getSettings();
  const absolutePath = normalizeAbsolutePath(settings.audioDownloadPath, "音频保存路径");
  if (absolutePath) {
    return nativeHostRequest({
      action: "download_audio",
      directory: absolutePath,
      url: parsed.toString(),
      filename: safeDownloadFilename(filename)
    });
  }
  const folder = normalizeDownloadFolder(settings.downloadFolder);
  const targetName = safeDownloadFilename(filename);
  return chrome.downloads.download({
    url: parsed.toString(),
    filename: folder ? `${folder}/${targetName}` : targetName,
    conflictAction: "uniquify",
    saveAs: Boolean(settings.downloadSaveAs)
  });
}

async function transcribeAudio({ url, filename, baseName, language = "zh" }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("音频地址无效");
  }
  if (parsed.protocol !== "https:") throw new Error("只支持转写 HTTPS 音频");
  const settings = await getSettings();
  const audioDirectory = normalizeAbsolutePath(settings.audioDownloadPath, "音频保存路径")
    || "~/Downloads/小宇宙音频";
  const transcriptDirectory = normalizeAbsolutePath(settings.transcriptDownloadPath, "转写稿保存路径")
    || "~/Downloads/小宇宙转写稿";
  return nativeHostRequest({
    action: "transcribe_remote",
    provider: settings.asrProvider,
    url: parsed.toString(),
    audioFilename: safeDownloadFilename(filename),
    baseName: safeDownloadFilename(baseName || filename).replace(/\.[^.]+$/, ""),
    audioDirectory,
    transcriptDirectory,
    language,
    qwenEndpoint: settings.qwenAsrEndpoint,
    qwenModel: settings.qwenAsrModel,
    doubaoEndpoint: settings.doubaoAsrEndpoint,
    doubaoResourceId: settings.doubaoAsrResourceId
  });
}

async function requestJson({ path, method = "POST", body, auth, retry = true }) {
  const settings = await getSettings();
  const directPath = API_ENDPOINTS[path] || path;
  const urlString = settings.apiMode === "proxy" && settings.proxyBaseUrl
    ? proxyUrl(settings.proxyBaseUrl, path)
    : upstreamUrl(directPath);
  const url = new URL(urlString);
  if (method === "GET" && body && typeof body === "object") {
    for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value));
  }
  if (path === "/discovery" && method === "POST") body = { returnAll: "false", ...(body || {}) };
  const headers = withAppHeaders(auth);
  if (auth?.refreshToken && path === "/app_auth_tokens.refresh") {
    headers["x-jike-refresh-token"] = auth.refreshToken;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(body ?? {})
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (response.status === 401 && retry && auth?.refreshToken) {
    const refreshed = await refreshToken(auth);
    return requestJson({ path, method, body, auth: refreshed, retry: false });
  }
  if (!response.ok) {
    const error = new Error(data?.message || data?.msg || `请求失败（${response.status}）`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { data, headers: response.headers };
}

async function refreshToken(auth) {
  const settings = await getSettings();
  const url = settings.apiMode === "proxy" && settings.proxyBaseUrl
    ? proxyUrl(settings.proxyBaseUrl, "/refresh_token")
    : upstreamUrl("/app_auth_tokens.refresh");
  const response = await fetch(url, {
    method: "POST",
    headers: withAppHeaders(auth, { "x-jike-refresh-token": auth.refreshToken }),
    body: settings.apiMode === "proxy" ? JSON.stringify({
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken
    }) : undefined
  });
  if (!response.ok) {
    await clearAuth();
    throw new Error("登录已过期，请重新登录");
  }
  const json = await response.json();
  const next = {
    ...auth,
    accessToken: json?.data?.accessToken || json?.data?.access_token || json?.data?.["x-jike-access-token"] || response.headers.get("x-jike-access-token") || auth.accessToken,
    refreshToken: json?.data?.refreshToken || json?.data?.refresh_token || json?.data?.["x-jike-refresh-token"] || response.headers.get("x-jike-refresh-token") || auth.refreshToken
  };
  return saveAuth(next);
}

async function loginWithSms({ areaCode = "+86", mobilePhoneNumber, verifyCode }) {
  const settings = await getSettings();
  const path = "/v1/auth/login-with-sms";
  const url = settings.apiMode === "proxy" && settings.proxyBaseUrl
    ? proxyUrl(settings.proxyBaseUrl, "/login")
    : upstreamUrl(path);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...APP_HEADERS, Origin: "https://podcaster.xiaoyuzhoufm.com" },
    body: JSON.stringify({ areaCode, mobilePhoneNumber, verifyCode })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.message || data?.msg || "登录失败");
  const auth = {
    user: data?.data?.user || data?.data?.data || data?.data || data?.user || null,
    accessToken: data?.data?.accessToken || data?.data?.access_token || data?.data?.["x-jike-access-token"] || response.headers.get("x-jike-access-token"),
    refreshToken: data?.data?.refreshToken || data?.data?.refresh_token || data?.data?.["x-jike-refresh-token"] || response.headers.get("x-jike-refresh-token"),
    deviceId: crypto.randomUUID()
  };
  if (!auth.accessToken) throw new Error("登录成功但没有收到访问凭证");
  return saveAuth(auth);
}

async function sendSmsCode({ areaCode = "+86", mobilePhoneNumber }) {
  const settings = await getSettings();
  const path = "/v1/auth/send-code";
  const url = settings.apiMode === "proxy" && settings.proxyBaseUrl
    ? proxyUrl(settings.proxyBaseUrl, "/send-code")
    : upstreamUrl(path);
  const response = await fetch(url, {
    method: "POST",
    headers: { ...APP_HEADERS, Origin: "https://podcaster.xiaoyuzhoufm.com" },
    body: JSON.stringify({ areaCode, mobilePhoneNumber })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.message || data?.msg || "验证码发送失败");
  return data;
}

async function fetchApi({ endpoint, method = "POST", body = {} }) {
  const auth = await authWithDeviceId(await getAuth());
  if (!auth?.accessToken) throw new Error("请先登录小宇宙");
  const { data } = await requestJson({ path: endpoint, method, body, auth });
  return data;
}

async function updateSettings(next) {
  const settings = { ...DEFAULT_SETTINGS, ...(await getSettings()), ...next };
  settings.asrSettingsVersion = ASR_SETTINGS_VERSION;
  settings.downloadFolder = normalizeDownloadFolder(settings.downloadFolder);
  settings.transcriptFolder = normalizeDownloadFolder(settings.transcriptFolder);
  settings.audioDownloadPath = normalizeAbsolutePath(settings.audioDownloadPath, "音频保存路径");
  settings.transcriptDownloadPath = normalizeAbsolutePath(settings.transcriptDownloadPath, "转写稿保存路径");
  settings.downloadSaveAs = Boolean(settings.downloadSaveAs);
  settings.asrProvider = ["qwen", "doubao"].includes(settings.asrProvider) ? settings.asrProvider : "qwen";
  if (settings.audioDownloadPath || settings.transcriptDownloadPath) {
    await nativeHostRequest({
      action: "ensure_directories",
      directories: [settings.audioDownloadPath, settings.transcriptDownloadPath].filter(Boolean)
    });
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function handleMessage(message) {
  switch (message?.type) {
    case "open-app":
      return openAppWindow();
    case "get-auth":
      return getAuth();
    case "logout":
      await clearAuth();
      return null;
    case "get-settings":
      return getSettings();
    case "update-settings":
      return updateSettings(message.settings);
    case "send-code":
      return sendSmsCode(message.payload);
    case "login":
      return loginWithSms(message.payload);
    case "api":
      return fetchApi(message.payload);
    case "download-audio":
      return downloadAudio(message.payload);
    case "transcribe-audio":
      return transcribeAudio(message.payload);
    case "get-native-host-status":
      return getNativeHostStatus();
    case "save-asr-credentials":
      return nativeHostRequest({ action: "save_asr_credentials", credentials: message.credentials || {} });
    case "choose-native-directory":
      return nativeHostRequest({ action: "choose_directory", prompt: message.prompt || "请选择保存目录" });
    default:
      throw new Error("未知操作");
  }
}

chrome.action.onClicked.addListener(() => openAppWindow().catch(console.error));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "请求失败", status: error.status || 0 }));
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const { [SETTINGS_KEY]: settings } = await chrome.storage.local.get(SETTINGS_KEY);
  if (!settings) await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
});

chrome.windows.onBoundsChanged.addListener(async (window) => {
  const current = await storedWindow();
  if (!current || current.id !== window.id || window.state !== "normal") return;
  await chrome.storage.local.set({
    [BOUNDS_KEY]: sanitizeBounds({ width: window.width, height: window.height, left: window.left, top: window.top })
  });
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { [WINDOW_KEY]: storedId } = await chrome.storage.session.get(WINDOW_KEY);
  if (windowId === storedId) await chrome.storage.session.remove(WINDOW_KEY);
});
