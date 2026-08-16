import assert from "node:assert/strict";
import {
  filterComments,
  isMeaningfulComment,
  parseNextDataComments
} from "../comment_utils.mjs";

for (const text of [
  "终于更新",
  "沙发！",
  "我来啦",
  "多多更新",
  "等了好久",
  "哈哈哈哈",
  "🎉🎉🎉"
]) {
  assert.equal(isMeaningfulComment(text), false, text);
}

assert.equal(
  isMeaningfulComment("嘉宾提到的决策框架很实用，但风险评估部分还可以展开。"),
  true
);

const source = [
  { text: "沙发", likeCount: 100 },
  {
    text: "关于远程协作的案例很具体，希望补充异步沟通的模板。",
    likeCount: 8,
    replies: [
      { text: "我也关心模板里如何处理紧急事项。", likeCount: 2 }
    ]
  },
  {
    text: "这期对风险边界的解释很清楚。",
    likeCount: 12,
    pinned: true
  },
  { text: "这期对风险边界的解释很清楚。", likeCount: 1 }
];

const filtered = filterComments(source);
assert.equal(filtered.totalCount, 5);
assert.equal(filtered.comments.length, 3);
assert.equal(filtered.comments[0].pinned, true);
assert.equal(filtered.comments[0].likeCount, 12);
assert.equal(filtered.filteredCount, 2);

const html = `<html><script id="__NEXT_DATA__" type="application/json">${
  JSON.stringify({ props: { pageProps: { comments: source } } })
}</script></html>`;
assert.equal(parseNextDataComments(html).length, 4);
assert.throws(
  () => parseNextDataComments("<html></html>"),
  /未包含评论数据/
);

console.log("comment_utils fixtures passed");
