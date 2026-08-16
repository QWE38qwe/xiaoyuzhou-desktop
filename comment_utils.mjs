const LOW_VALUE_PATTERN = /^(?:终于更新(?:了)?|沙发|前排|占座|占个座|蹲|打卡|来了|我来啦|好耶|支持|催更|多多更新|快更新|等了好久|期待(?:更新)?|哈哈+|嘿嘿+|谢谢分享|先赞后听|先听为敬|留个脚印)[!！?？~～。.，,\s]*$/i;
const SYMBOLS_ONLY_PATTERN = /^[\p{P}\p{S}\s]+$/u;

export function commentText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMeaningfulComment(value) {
  const text = commentText(value);
  if (!text || text.length > 2000) return false;
  if (SYMBOLS_ONLY_PATTERN.test(text) || LOW_VALUE_PATTERN.test(text)) return false;
  if (/^(.)\1{3,}$/u.test(text)) return false;
  if (text.length < 6 && !/[?？]/.test(text)) return false;
  return true;
}

function collectComments(items, output) {
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    output.push(item);
    collectComments(item.replies, output);
  }
}

export function filterComments(items, { limit = 80, maxChars = 20_000 } = {}) {
  const candidates = [];
  collectComments(items, candidates);
  const seen = new Set();
  const accepted = candidates
    .map((item) => ({
      text: commentText(item.text || item.content || item.comment),
      likeCount: Math.max(0, Number(item.likeCount) || 0),
      replyCount: Math.max(
        0,
        Number(item.replyCount ?? item.threadReplyCount) || 0
      ),
      pinned: Boolean(item.pinned)
    }))
    .filter((item) => {
      const key = item.text.toLocaleLowerCase("zh-CN");
      if (!isMeaningfulComment(item.text) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => (
      Number(right.pinned) - Number(left.pinned)
      || right.likeCount - left.likeCount
      || right.replyCount - left.replyCount
    ));

  const comments = [];
  let size = 0;
  for (const item of accepted) {
    if (comments.length >= limit || size + item.text.length > maxChars) break;
    comments.push(item);
    size += item.text.length;
  }
  return {
    comments,
    totalCount: candidates.length,
    filteredCount: Math.max(0, candidates.length - comments.length)
  };
}

export function parseNextDataComments(html) {
  const match = String(html || "").match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) throw new Error("单集页面未包含评论数据");
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    throw new Error("单集页面评论数据格式异常");
  }
  return Array.isArray(data?.props?.pageProps?.comments)
    ? data.props.pageProps.comments
    : [];
}
