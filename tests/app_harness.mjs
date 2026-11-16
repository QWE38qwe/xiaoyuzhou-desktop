import { readFileSync } from "node:fs";
import vm from "node:vm";
import { filterComments, parseNextDataComments } from "../comment_utils.mjs";

const readSource = (name) => readFileSync(new URL("../" + name, import.meta.url), "utf8");
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
export const episode = (eid, description = "00:30 开场\n02:00 话题") => ({
  type: "EPISODE", eid, pid: "p", title: eid, description,
  podcast: { pid: "p", title: "Podcast" }, duration: 600,
  media: { source: { url: "https://media.xyzcdn.net/" + eid + ".mp3" } }
});

// A small event/DOM double. It executes the real application and event handlers;
// audio, extension storage, network and the passage of time stay controllable.
class Element {
  constructor(tagName = "div", attributes = {}) {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.dataset = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith("data-")) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    const classes = new Set((attributes.class || "").split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...values) => values.forEach((v) => classes.add(v)),
      remove: (...values) => values.forEach((v) => classes.delete(v)),
      contains: (v) => classes.has(v),
      toggle: (v, force = !classes.has(v)) => { force ? classes.add(v) : classes.delete(v); return force; }
    };
    this.id = attributes.id || "";
    this.value = attributes.value || "";
    this.checked = "checked" in attributes;
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this._text = "";
    this.open = false;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(html) {
    this._html = html;
    this.children = [];
    this._text = "";
    const stack = [this];
    const voidTags = new Set(["INPUT", "IMG", "BR", "LINK", "META", "HR", "SOURCE"]);
    for (const token of String(html).match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith("</")) {
        if (stack.length > 1) stack.pop();
      } else if (/^<[a-z]/i.test(token)) {
        const [, tag, raw] = token.match(/^<(\w+)([\s\S]*?)\/?\s*>$/) || [];
        if (!tag) continue;
        const attrs = {};
        for (const match of raw.matchAll(/([\w:-]+)(?:="([^"]*)"|='([^']*)')?/g)) attrs[match[1]] = match[2] ?? match[3] ?? "";
        const node = new Element(tag, attrs);
        stack.at(-1).appendChild(node);
        if (!voidTags.has(node.tagName) && !token.endsWith("/>")) stack.push(node);
      } else if (!token.startsWith("<")) stack.at(-1)._text += token;
    }
  }
  get innerHTML() { return this._html || ""; }
  appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
  append(value) { this._text += String(value); }
  replaceChildren(value) { this.textContent = value; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  matches(selector) {
    return selector.split(",").some((part) => {
      part = part.trim();
      if (part.startsWith("#")) return this.id === part.slice(1);
      if (part.startsWith(".")) return part.slice(1).split(".").every((c) => this.classList.contains(c));
      const attr = part.match(/^\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
      if (attr) return attr[2] === undefined ? attr[1] in this.attributes : this.attributes[attr[1]] === attr[2];
      return this.tagName.toLowerCase() === part;
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap((node) => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  addEventListener(type, handler, options = {}) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ handler, once: options.once }); this.listeners.set(type, listeners);
  }
  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((entry) => entry.handler !== handler));
  }
  emit(type, event = {}) {
    event.target ||= this; event.currentTarget = this; event.preventDefault ||= () => {}; event.stopPropagation ||= () => {};
    const values = [];
    for (const entry of [...this.listeners.get(type) || []]) {
      if (entry.once) this.removeEventListener(type, entry.handler);
      values.push(entry.handler(event));
    }
    if (this["on" + type]) values.push(this["on" + type](event));
    return Promise.all(values);
  }
  async click() {
    for (let node = this; node; node = node.parentElement) await node.emit("click", { target: this });
  }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit("close"); }
  scrollIntoView() { this.scrolled = true; }
  focus() {}
}

class Audio extends Element {
  constructor() {
    super("audio", { id: "audio" });
    this._src = ""; this.duration = NaN; this.readyState = 0;
    this.currentTime = 0; this.paused = true; this.ended = false;
    this.playCalls = 0; this.sourceChanges = 0; this.playResult = () => Promise.resolve();
    this.playbackRate = 1;
  }
  set src(value) {
    this._src = value; this.sourceChanges++;
    this.currentTime = 0; this.duration = NaN; this.readyState = 0; this.ended = false;
  }
  get src() { return this._src; }
  get currentSrc() { return this._src; }
  async play() {
    this.playCalls++;
    await this.playResult();
    this.paused = false;
    await this.emit("play");
    await this.emit("playing");
  }
  pause() { this.paused = true; this.emit("pause"); }
  async metadata(duration = 600) {
    this.duration = duration; this.readyState = 1; await this.emit("loadedmetadata");
  }
}

export function backgroundHarness() {
  const stored = {};
  const requests = [];
  const hooks = { addListener() {} };
  const permissions = { contains: async () => true, request: async () => true };
  const local = {
    get: async (key) => ({ [key]: structuredClone(stored[key]) }),
    set: async (items) => { Object.assign(stored, structuredClone(items)); },
    remove: async (key) => { delete stored[key]; }
  };
  const sandbox = {
    console, URL, crypto: { randomUUID: () => "test-device" }, filterComments, parseNextDataComments,
    navigator: { userAgent: "Windows" },
    browser: {
      permissions, action: { onClicked: hooks }, windows: { onFocusChanged: hooks, onRemoved: hooks },
      storage: { local, session: local },
      runtime: { onMessage: hooks, onInstalled: hooks, id: "test@example.org", sendNativeMessage: (_host, message, callback) => {
        requests.push(message);
        const response = { ok: true, data: { markdown: "/summary.md" } };
        if (callback) callback(response);
        else return Promise.resolve(response);
      } }
    },
    fetch: async () => { throw new Error("Unexpected network request"); }
  };
  sandbox.chrome = sandbox.browser;
  vm.createContext(sandbox);
  vm.runInContext(readSource("settings_policy.js"), sandbox, { filename: "settings_policy.js" });
  vm.runInContext(readSource("background.js").replace(/^import .*;\r?$/gm, ""), sandbox, { filename: "background.js" });
  return { sandbox, stored, local, permissions, requests, run: (code) => vm.runInContext(code, sandbox) };
}

export function appHarness({ backend = backgroundHarness() } = {}) {
  const document = new Element("document");
  document.innerHTML = readSource("app.html");
  document.body = new Element("body");
  document.createElement = (tag) => new Element(tag);
  const oldAudio = document.querySelector("#audio");
  const audio = new Audio();
  oldAudio.parentElement.children.splice(oldAudio.parentElement.children.indexOf(oldAudio), 1, audio);
  audio.parentElement = oldAudio.parentElement;
  const timers = new Map(); let timerId = 0;
  const calls = [];
  const h = { document, audio, backend, calls, timers, apiHandler: async () => ({ data: [] }) };
  const sandbox = {
    console, URL, document, navigator: { clipboard: { writeText: async () => {} } },
    window: { scrollY: 0, scrollTo() {}, addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} }, confirm: () => true,
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => callback(),
    browser: {
      permissions: backend.permissions, storage: { onChanged: { addListener() {} } },
      runtime: { sendMessage: async (message) => {
        calls.push(message);
        try {
          const data = message.type === "api"
            ? await h.apiHandler(message.payload.endpoint, message.payload.body)
            : await backend.sandbox.handleMessage(message);
          return { ok: true, data };
        } catch (error) { return { ok: false, error: error.message }; }
      } }
    }
  };
  sandbox.chrome = sandbox.browser;
  vm.createContext(sandbox);
  for (const name of ["settings_policy.js", "episode_content.js", "qrcode.js"]) vm.runInContext(readSource(name), sandbox, { filename: name });
  vm.runInContext(readSource("app.js").replace(/init\(\)\.catch\(\(error\) => notify\(error\.message\)\);\s*$/, ""), sandbox, { filename: "app.js" });
  h.run = (code) => vm.runInContext(code, sandbox);
  h.state = h.run("state");
  h.sandbox = sandbox;
  h.node = (selector) => document.querySelector(selector);
  h.cache = (...episodes) => episodes.forEach((item) => h.state.episodeDetails.set(item.eid, item));
  h.start = (item, options) => sandbox.openEpisode(item, options);
  h.seek = (item, seconds) => sandbox.seekToTimestamp(seconds, { episode: item });
  h.played = () => calls.filter((m) => m.payload?.endpoint === "/played_create");
  sandbox.initPlayer();
  return h;
}
