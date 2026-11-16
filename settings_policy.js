// Shared by the extension page and the background module.
(() => {
  function proxyOrigin(value) {
    let url;
    try { url = new URL(String(value || "").trim()); } catch {
      throw new Error("代理地址无效，请填写 HTTPS 地址");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("代理必须使用 HTTPS，且不能包含凭据、查询参数或片段");
    }
    // Match patterns do not support ports. Restrict to the standard HTTPS port.
    if (url.port) throw new Error("代理必须使用标准 HTTPS 端口 443");
    return `${url.origin}/*`;
  }

  function summaryConsentScope(settings = {}) {
    const provider = settings.summaryProvider || "qwen";
    const config = settings.summaryProviders?.[provider] || {};
    const source = settings.transcriptSource || "official";
    const asr = source === "asr" ? settings.asrProvider || "qwen" : "";
    const asrEndpoint = asr === "qwen" ? settings.qwenAsrEndpoint
      : asr === "doubao" ? settings.doubaoAsrEndpoint : "";
    return JSON.stringify([
      1, provider, config.endpoint || "", config.model || "", source, asr,
      asrEndpoint || "", Boolean(settings.summaryIncludeComments)
    ]);
  }

  function hasSummaryConsent(settings) {
    return Boolean(settings?.summaryConsentAccepted
      && settings.summaryConsentScope === summaryConsentScope(settings));
  }

  globalThis.XYZSettingsPolicy = Object.freeze({ proxyOrigin, summaryConsentScope, hasSummaryConsent });
})();
