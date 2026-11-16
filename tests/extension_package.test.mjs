import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 允许出现在扩展包内的文件（白名单）。新增运行时文件时必须同步这里。
const PACKAGE_WHITELIST = new Set([
  "manifest.json",
  "app.html",
  "app.js",
  "app.css",
  "background.js",
  "qrcode.js",
  "episode_content.js",
  "comment_utils.mjs",
  "settings_policy.js",
  "LICENSE"
]);

const PACKAGE_WHITELIST_DIRS =
  /^icons\/[a-z0-9-]+\.png$/i;

// 非运行时的开发文件，不应被打包，也不该出现在包根目录
// 这些是一次性开发脚本的命名特征；注意不要把正常运行文件（如 qrcode.js）误伤
const FORBIDDEN_PATTERNS = [
  /^qr_patch/i,
  /^patch_/i,
  /^peek_/i,
  /^audit\d*\.mjs$/i,
  /^add_[a-z_]+\.mjs$/i,
  /^rm_/i,
  /^check_[a-z_]+\.mjs$/i,
  /^fix\d+\.mjs$/i,
  /^repro_/i,
  /^probe\d*\.mjs$/i,
  /^cap\d*\.mjs$/i,
  /^login\d*\.mjs$/i,
  /^midway\d*\.mjs$/i,
  /^pub\d*\.mjs$/i,
  /^amo\d*\.mjs$/i,
  /^qr\d*\.mjs$/i
];

function walk(directory, results = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "tests" || entry.name === "node_modules") continue;
    const entryPath = path.join(directory, entry.name);
    const relative = path.relative(projectRoot, entryPath).split(path.sep).join("/");
    if (entry.isDirectory()) walk(entryPath, results);
    else results.push(relative);
  }
  return results;
}

test("unpacked extension contains no Chrome-reserved names", () => {
  const reserved = walk(projectRoot).filter((p) =>
    p.split("/").some((segment) => segment.startsWith("_"))
  );
  assert.deepEqual(reserved, []);
});

test("extensions never ship development scripts", () => {
  const files = walk(projectRoot);
  const suspicious = files.filter((relative) => {
    const name = path.basename(relative);
    if (relative.startsWith("tests/")) return false;
    return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(name));
  });
  assert.deepEqual(suspicious, [], "包内混入了开发用脚本：" + suspicious.join(", "));
});

test("runtime files all sit in the packaging whitelist", () => {
  const files = walk(projectRoot).filter((relative) => !relative.startsWith("tests/"));
  const unexpected = files.filter((relative) => {
    if (PACKAGE_WHITELIST.has(relative)) return false;
    if (PACKAGE_WHITELIST_DIRS.test(relative)) return false;
    return true;
  });
  // 允许文档与安装脚本留在仓库但不打包
  const repoOnly = /^(\.gitignore|[A-Z][A-Z-]*\.md|install_[a-z_]+\.(sh|ps1)|[a-z_]+\.py)$/;
  const repoOnlyDir = /^(docs|demo|store-assets)\//;
  const offenders = unexpected.filter((relative) =>
    !repoOnly.test(relative) && !repoOnlyDir.test(relative)
  );
  assert.deepEqual(offenders, [], "这些文件既不在白名单也不是已知的仓库文件：" + offenders.join(", "));
});
