(() => {
  const MESSAGE_TYPE = "__CHATGPT_IMAGE_DOWNLOADER_CANDIDATE__";
  const SNAPSHOT_TYPE = "__CHATGPT_IMAGE_DOWNLOADER_SNAPSHOT__";
  const IMAGE_KEY = /(image|img|photo|picture|thumbnail|source|asset|file|download|url|src)/i;
  const MAX_DEPTH = 7;
  const MAX_ITEMS = 180;
  const recentCandidates = new Map();
  const blobSources = new WeakMap();
  const pendingBlobSources = [];
  let autoPaginationRunning = false;
  let autoPaginationStarted = false;

  const rememberPendingBlobSource = (url) => {
    pendingBlobSources.push(url);
    if (pendingBlobSources.length > 300) pendingBlobSources.shift();
  };

  const claimPendingBlobSource = (url = "") => {
    const index = url ? pendingBlobSources.indexOf(url) : 0;
    if (index < 0 || !pendingBlobSources.length) return "";
    return pendingBlobSources.splice(index, 1)[0] || "";
  };

  const isEstuaryUrl = (value) => {
    try {
      return new URL(value, window.location.href).pathname === "/backend-api/estuary/content";
    } catch {
      return false;
    }
  };

  const isThumbnailUrl = (value) => {
    try {
      const id = decodeURIComponent(new URL(value, window.location.href).searchParams.get("id") || "");
      return /#thumbnail/i.test(id);
    } catch {
      return /thumbnail/i.test(String(value || ""));
    }
  };

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

  const emitCandidate = (candidate) => {
    window.postMessage({ type: MESSAGE_TYPE, candidate }, window.location.origin);
  };

  const postCandidate = (candidate) => {
    if (!candidate || !candidate.url || !isHttpUrl(candidate.url)) return;
    const normalized = {
      url: new URL(candidate.url, window.location.href).href,
      blobUrl: typeof candidate.blobUrl === "string" && candidate.blobUrl.startsWith("blob:") ? candidate.blobUrl : "",
      name: typeof candidate.name === "string" ? candidate.name.slice(0, 180) : "",
      prompt: typeof candidate.prompt === "string" ? candidate.prompt.slice(0, 300) : "",
      createdAt: candidate.createdAt || "",
      needsResolution: Boolean(candidate.needsResolution),
      fromMyImagesApi: Boolean(candidate.fromMyImagesApi)
    };
    const key = normalized.blobUrl || normalized.url;
    recentCandidates.set(key, normalized);
    if (recentCandidates.size > 1200) recentCandidates.delete(recentCandidates.keys().next().value);
    emitCandidate(normalized);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type !== SNAPSHOT_TYPE) return;
    recentCandidates.forEach(emitCandidate);
  });

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

  const publishRecentImages = (json) => {
    (Array.isArray(json?.items) ? json.items : []).forEach((item) => {
      if (!item || item.output_blocked || item.is_archived || !isEstuaryUrl(item.url)) return;
      postCandidate({
        url: item.url,
        name: item.title || item.id || "",
        prompt: item.prompt || item.recreation_prompt || "",
        createdAt: item.created_at || "",
        fromMyImagesApi: true
      });
    });
  };

  const makeNextPageRequest = (requestUrl, args, cursor) => {
    const nextUrl = new URL(requestUrl, window.location.href);
    nextUrl.searchParams.set("limit", "100");
    nextUrl.searchParams.set("after", cursor);
    if (args[0] instanceof Request) return new Request(nextUrl.href, args[0]);
    return new Request(nextUrl.href, args[1] || {});
  };

  const autoPaginate = async (requestUrl, args, firstCursor) => {
    if (autoPaginationStarted || autoPaginationRunning || !firstCursor) return;
    autoPaginationStarted = true;
    autoPaginationRunning = true;
    let cursor = firstCursor;
    const seen = new Set();
    try {
      for (let page = 0; cursor && page < 200 && !seen.has(cursor); page += 1) {
        seen.add(cursor);
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        const response = await nativeFetch(makeNextPageRequest(requestUrl, args, cursor));
        if (!response.ok) break;
        const json = await response.json();
        publishRecentImages(json);
        cursor = typeof json?.cursor === "string" ? json.cursor : "";
      }
    } catch {
      // The normal page scanner remains available if automatic pagination is interrupted.
    } finally {
      autoPaginationRunning = false;
    }
  };

  const inspectResponse = async (response, requestUrl, requestArgs = null) => {
    try {
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json") && !/\/api\/|backend-api|conversation/i.test(requestUrl)) return;
      const json = await response.clone().json();
      if (/\/backend-api\/my\/recent\/image_gen(?:\?|$)/i.test(requestUrl)) {
        publishRecentImages(json);
        if (requestArgs) void autoPaginate(requestUrl, requestArgs, json?.cursor);
        return;
      }
      walk(json, { imageField: false });
    } catch {
      // Most requests are not JSON or are intentionally not readable; ignore them.
    }
  };

  const nativeFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
    if (isEstuaryUrl(requestUrl)) {
      rememberPendingBlobSource(response.url || new URL(requestUrl, window.location.href).href);
      postCandidate({ url: requestUrl, needsResolution: isThumbnailUrl(requestUrl) });
    }
    void inspectResponse(response, requestUrl, args);
    return response;
  };

  const nativeResponseBlob = Response.prototype.blob;
  Response.prototype.blob = async function patchedResponseBlob(...args) {
    const blob = await nativeResponseBlob.apply(this, args);
    if (isEstuaryUrl(this.url)) {
      blobSources.set(blob, this.url);
      claimPendingBlobSource(this.url);
    }
    return blob;
  };

  const nativeCreateObjectUrl = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function patchedCreateObjectURL(object) {
    const blobUrl = nativeCreateObjectUrl(object);
    const sourceUrl = blobSources.get(object) ||
      (object instanceof Blob && /^image\//i.test(object.type || "") ? claimPendingBlobSource() : "");
    if (sourceUrl) {
      postCandidate({
        url: sourceUrl,
        blobUrl,
        needsResolution: isThumbnailUrl(sourceUrl)
      });
    }
    return blobUrl;
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
        if (isEstuaryUrl(this.__chatgptImageRequestUrl || "")) {
          if (this.response instanceof Blob) blobSources.set(this.response, this.__chatgptImageRequestUrl);
          else rememberPendingBlobSource(this.__chatgptImageRequestUrl);
          postCandidate({
            url: this.__chatgptImageRequestUrl,
            needsResolution: isThumbnailUrl(this.__chatgptImageRequestUrl)
          });
        }
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
