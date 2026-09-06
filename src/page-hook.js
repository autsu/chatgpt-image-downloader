(() => {
  const MESSAGE_TYPE = "__CHATGPT_IMAGE_DOWNLOADER_CANDIDATE__";
  const IMAGE_KEY = /(image|img|photo|picture|thumbnail|source|asset|file|download|url|src)/i;
  const MAX_DEPTH = 7;
  const MAX_ITEMS = 180;

  const isHttpUrl = (value) => {
    try {
      const url = new URL(value, window.location.href);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  };

  const isLikelyImageUrl = (value) => {
    if (!isHttpUrl(value)) return false;
    try {
      const url = new URL(value, window.location.href);
      const haystack = `${url.hostname}${url.pathname}${url.search}`.toLowerCase();
      return (
        /\.(png|jpe?g|webp|gif|avif|bmp|tiff?)(?:$|[?#])/.test(haystack) ||
        /oaiusercontent|openaiusercontent|blob\.core\.windows\.net|dalle|generated|\/files\//.test(haystack)
      );
    } catch {
      return false;
    }
  };

  const postCandidate = (candidate) => {
    if (!candidate || !candidate.url || !isHttpUrl(candidate.url)) return;
    window.postMessage({
      type: MESSAGE_TYPE,
      candidate: {
        url: new URL(candidate.url, window.location.href).href,
        name: typeof candidate.name === "string" ? candidate.name.slice(0, 180) : "",
        prompt: typeof candidate.prompt === "string" ? candidate.prompt.slice(0, 300) : "",
        createdAt: candidate.createdAt || ""
      }
    }, window.location.origin);
  };

  const walk = (value, context = {}, depth = 0, seen = new WeakSet()) => {
    if (depth > MAX_DEPTH || value == null) return;
    if (typeof value === "string") {
      if (isLikelyImageUrl(value) || context.imageField) {
        postCandidate({
          url: value,
          name: context.name,
          prompt: context.prompt,
          createdAt: context.createdAt
        });
      }
      return;
    }
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.slice(0, MAX_ITEMS).forEach((item) => walk(item, context, depth + 1, seen));
      return;
    }

    const nextContext = {
      name: typeof value.name === "string" ? value.name : context.name,
      prompt: typeof value.prompt === "string" ? value.prompt : context.prompt,
      createdAt: value.created_at || value.createdAt || context.createdAt,
      imageField: context.imageField
    };

    Object.entries(value).slice(0, MAX_ITEMS).forEach(([key, child]) => {
      const imageField = context.imageField || IMAGE_KEY.test(key);
      walk(child, { ...nextContext, imageField }, depth + 1, seen);
    });
  };

  const inspectResponse = async (response, requestUrl) => {
    try {
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json") && !/\/api\/|backend-api|conversation/i.test(requestUrl)) return;
      const json = await response.clone().json();
      walk(json, { imageField: false });
    } catch {
      // Most requests are not JSON or are intentionally not readable; ignore them.
    }
  };

  const nativeFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    void inspectResponse(response, requestUrl);
    return response;
  };

  const NativeXHR = window.XMLHttpRequest;
  const open = NativeXHR.prototype.open;
  const send = NativeXHR.prototype.send;

  NativeXHR.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__chatgptImageRequestUrl = url;
    return open.call(this, method, url, ...rest);
  };

  NativeXHR.prototype.send = function patchedSend(...args) {
    this.addEventListener("load", () => {
      try {
        const contentType = this.getResponseHeader("content-type") || "";
        if (!contentType.includes("json") && !/\/api\/|backend-api|conversation/i.test(this.__chatgptImageRequestUrl || "")) return;
        walk(JSON.parse(this.responseText), { imageField: false });
      } catch {
        // Ignore non-JSON responses and aborted requests.
      }
    });
    return send.apply(this, args);
  };
})();
