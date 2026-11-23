import { readFileSync } from "node:fs";
import vm from "node:vm";

const readSource = (name) => readFileSync(new URL("../" + name, import.meta.url), "utf8");
const locksByStorage = new WeakMap();
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
    this.hidden = "hidden" in attributes;
    this.disabled = "disabled" in attributes;
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
  replaceChildren(value = "") { this.textContent = value; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  removeAttribute(key) { delete this.attributes[key]; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  matches(selector) {
    return selector.split(",").some((part) => {
      part = part.trim();
      if (/\s/.test(part) && !part.includes("[")) {
        const firstSpace = part.indexOf(" ");
        return this.matches(part.slice(firstSpace + 1)) && Boolean(this.parentElement?.closest(part.slice(0, firstSpace)));
      }
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
    if (this.disabled) return;
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
    this.paused = true;
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
  async finish() {
    this.currentTime = this.duration;
    this.ended = true;
    this.paused = true;
    await this.emit("ended");
  }
  async metadata(duration = 600) {
    this.duration = duration; this.readyState = 1; await this.emit("loadedmetadata");
  }
}

export function appHarness({ storage = new Map(), auth = { user: { nickname: "测试用户" } } } = {}) {
  if (!locksByStorage.has(storage)) locksByStorage.set(storage, new Map());
  const locks = locksByStorage.get(storage);
  const document = new Element("document");
  document.innerHTML = readSource("app.html");
  document.body = document.querySelector("body");
  const oldAudio = document.querySelector("#audio");
  const audio = new Audio();
  oldAudio.parentElement.children.splice(oldAudio.parentElement.children.indexOf(oldAudio), 1, audio);
  audio.parentElement = oldAudio.parentElement;
  const windowEvents = new Element();
  const calls = [];
  const harness = {
    audio, calls, storage, windowEvents, apiHandler: async () => ({ data: [] }),
    node: (selector) => document.querySelector(selector)
  };
  const sandbox = {
    console, URL, document,
    navigator: { locks: { request(name, task) {
      const pending = (locks.get(name) || Promise.resolve()).then(task);
      locks.set(name, pending.catch(() => {}));
      return pending;
    } } },
    window: { scrollY: 0, scrollTo() {}, addEventListener: (...args) => windowEvents.addEventListener(...args) },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: () => 1, clearTimeout() {},
    requestAnimationFrame: (callback) => callback(),
    chrome: {
      storage: { onChanged: { addListener() {} } },
      runtime: { sendMessage(message, callback) {
        calls.push(message);
        Promise.resolve().then(() => {
          if (message.type === "api") return harness.apiHandler(message.payload.endpoint, message.payload.body);
          if (message.type === "get-auth") return auth;
          if (message.type === "get-settings") return {};
          if (message.type === "get-summary-history") return {};
          if (message.type === "get-native-host-status") return {};
          throw new Error("Unexpected message " + message.type);
        }).then((data) => callback({ ok: true, data }), (error) => callback({ ok: false, error: error.message }));
      } }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(readSource("episode_content.js"), sandbox, { filename: "episode_content.js" });
  vm.runInContext(readSource("app.js").replace(/^init\(\)\.catch.*$/m, ""), sandbox, { filename: "app.js" });
  harness.init = () => sandbox.init();
  return harness;
}
