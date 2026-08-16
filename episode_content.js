(function exposeEpisodeContent(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.XYZEpisodeContent = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createEpisodeContent() {
  const TIMESTAMP_PATTERN = /(?:^|[\s[(【])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s\])】,，.。:：;；、-])/;

  function parseTimestamp(value) {
    const parts = String(value || "").trim().split(":").map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
      return null;
    }
    const seconds = parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
    if (parts.at(-1) >= 60 || (parts.length === 3 && parts[1] >= 60)) return null;
    return seconds;
  }

  function formatTimestamp(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const tail = String(seconds % 60).padStart(2, "0");
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${tail}`
      : `${String(minutes).padStart(2, "0")}:${tail}`;
  }

  function timestampFromLine(line) {
    const match = String(line || "").match(TIMESTAMP_PATTERN);
    if (!match) return null;
    const seconds = parseTimestamp(match[1]);
    return seconds === null ? null : {
      seconds,
      label: formatTimestamp(seconds),
      source: match[1],
      text: String(line || "")
        .replace(match[1], "")
        .replace(/^[\s*•·+\-–—:：、,，.。;；()[\]【】]+/, "")
        .replace(/[\s*•·+\-–—:：、,，.。;；()[\]【】]+$/, "")
        .trim()
    };
  }

  function isHeading(line) {
    const value = String(line || "").trim();
    return (
      /^#{1,6}\s+\S/.test(value)
      || /^(?:Part|PART)\s*\d+\b/.test(value)
      || /^第[一二三四五六七八九十\d]+(?:部分|章|节)\b/.test(value)
      || /^(?:时间轴|时间线|Timeline)\s*[:：]?$/.test(value)
    );
  }

  function parseContent(value) {
    const lines = String(value || "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const blocks = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const timestamp = timestampFromLine(line);
      if (timestamp) {
        blocks.push({ type: "timestamp", ...timestamp });
      } else if (isHeading(line)) {
        blocks.push({
          type: "heading",
          text: line.replace(/^#{1,6}\s+/, "").replace(/[:：]\s*$/, "")
        });
      } else if (/^(?:[-*•·]|\d+[.)、])\s+/.test(line)) {
        blocks.push({ type: "bullet", text: line.replace(/^(?:[-*•·]|\d+[.)、])\s+/, "") });
      } else {
        blocks.push({ type: "paragraph", text: line });
      }
    }
    return blocks;
  }

  function extractTimeline(value) {
    const seen = new Set();
    return parseContent(value)
      .filter((block) => block.type === "timestamp")
      .sort((left, right) => left.seconds - right.seconds)
      .filter((block) => {
        if (seen.has(block.seconds)) return false;
        seen.add(block.seconds);
        return true;
      });
  }

  function deepLink(episodeId, seconds) {
    const eid = String(episodeId || "").trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(eid)) return "";
    const timestamp = Math.max(0, Math.floor(Number(seconds) || 0));
    return `cosmos://page.cos/shownotes/${eid}?t=${timestamp}&utm_source=xiaoyuzhou_desktop`;
  }

  return {
    deepLink,
    extractTimeline,
    formatTimestamp,
    parseContent,
    parseTimestamp,
    timestampFromLine
  };
});
