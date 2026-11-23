import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function chromeReservedEntries(directory, results = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.name.startsWith("_")) {
      results.push(path.relative(projectRoot, entryPath));
    }
    if (entry.isDirectory()) chromeReservedEntries(entryPath, results);
  }
  return results;
}

test("unpacked extension contains no Chrome-reserved names", () => {
  assert.deepEqual(chromeReservedEntries(projectRoot), []);
});

test("manifest and application page point to packaged resources", () => {
  const read = (name) => readFileSync(path.join(projectRoot, name), "utf8");
  const manifest = JSON.parse(read("manifest.json"));
  const page = read("app.html");
  const references = [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.background.service_worker,
    ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
    ...Array.from(page.matchAll(/<(?:script|link)\s[^>]*(?:src|href)="([^"]+)"/g), (match) => match[1])
  ];
  for (const reference of references) {
    assert.ok(existsSync(path.join(projectRoot, reference)), `Missing extension resource: ${reference}`);
  }
});

