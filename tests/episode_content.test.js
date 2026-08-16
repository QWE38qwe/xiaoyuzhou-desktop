const assert = require("node:assert/strict");
const {
  deepLink,
  extractTimeline,
  formatTimestamp,
  parseTimestamp
} = require("../episode_content.js");

assert.equal(parseTimestamp("01:42:37"), 6157);
assert.equal(parseTimestamp("19:07"), 1147);
assert.equal(parseTimestamp("12:99"), null);
assert.equal(formatTimestamp(6157), "1:42:37");

const timeline = extractTimeline(`
时间轴
19:07 第二部分
[00:01:50] 开场
00:01:50 重复时间点
`);

assert.deepEqual(
  timeline.map(({ seconds, text }) => ({ seconds, text })),
  [
    { seconds: 110, text: "开场" },
    { seconds: 1147, text: "第二部分" }
  ]
);
assert.equal(
  deepLink("episode_123", 110.9),
  "cosmos://page.cos/shownotes/episode_123?t=110&utm_source=xiaoyuzhou_desktop"
);
assert.equal(deepLink("../unsafe", 1), "");

console.log("episode_content fixtures passed");
