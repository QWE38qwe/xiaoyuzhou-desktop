import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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

