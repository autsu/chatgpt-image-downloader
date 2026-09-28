(() => {
  const PAGE_MESSAGE = "__CHATGPT_IMAGE_DOWNLOADER_CANDIDATE__";
  const pending = new Map();
  const deferredCandidates = new Map();
  const scopedUrls = new Set();
  const scopedPaths = new Set();
  const scopedAssetIds = new Set();
  let myImagesScope = null;
  let flushTimer = null;

  const isHttpUrl = (value) => /^https?:\/\//i.test(value || "");

  const runtimeIsAlive = () => {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  const sendRuntimeMessage = (message, callback = () => {}) => {
    if (!runtimeIsAlive()) return;
    try {
      chrome.runtime.sendMessage(message, callback);
    } catch {
      // The page can outlive a reloaded extension. Stop quietly in that case.
    }
  };

  const compactText = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();

  const isMyImagesHeading = (element) => {
    const text = compactText(element.textContent);
    return text === "我的图片" || text === "my images" || text === "my pictures" ||
      text.startsWith("我的图片 ") || text.startsWith("my images ") || text.startsWith("my pictures ");
  };

  const findMyImagesScope = () => {
    const headings = [...document.querySelectorAll("h1, h2, h3, h4, [role='heading']")];
    const heading = headings.find(isMyImagesHeading) ||
      [...document.querySelectorAll("div, span, p")].find(isMyImagesHeading);
    if (!heading) return null;

    let node = heading;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      if (node.querySelector("img")) return node;
    }
    return heading.parentElement;
  };

  const pathKey = (value) => {
    try {
      const url = new URL(value, window.location.href);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "";
    }
  };

  const estuaryFileId = (value) => {
    try {
      const url = new URL(value, window.location.href);
      const id = decodeURIComponent(url.searchParams.get("id") || "");
      return id.match(/file_[a-z0-9]+/i)?.[0]?.toLowerCase() || "";
    } catch {
      return "";
    }
  };

  const assetId = (value) => {
    try {
      const url = new URL(value, window.location.href);
      const fileId = estuaryFileId(url.href);
      if (fileId) return fileId;
      const path = decodeURIComponent(url.pathname);
      const uuid = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];
      if (uuid) return uuid.toLowerCase();
      const tail = path.split("/").filter(Boolean).at(-1) || "";
      const cleaned = tail.replace(/\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i, "");
      return cleaned.length >= 8 && /^[a-z0-9_-]+$/i.test(cleaned) ? cleaned.slice(-80).toLowerCase() : "";
    } catch {
      return "";
    }
  };

  const isThumbnailUrl = (value) => {
    if (!isHttpUrl(value)) return true;
    try {
      const url = new URL(value, window.location.href);
      const haystack = `${url.pathname}${url.search}`.toLowerCase();
      return (
        /\.webp(?:$|[?#])/.test(haystack) ||
        /thumbnail|thumb|preview|small|resize|low[_-]?res/.test(haystack) ||
        /(?:format|fm|output)=webp(?:&|$)/.test(url.search.toLowerCase())
      );
    } catch {
      return true;
    }
  };

  const isInMyImagesScope = (url) => {
    if (!isHttpUrl(url) || isThumbnailUrl(url)) return false;
    const id = assetId(url);
    return scopedUrls.has(url) || scopedPaths.has(pathKey(url)) || (id && scopedAssetIds.has(id));
  };

  const refreshScope = () => {
    const nextScope = findMyImagesScope();
    if (!nextScope) {
      myImagesScope = null;
      scopedUrls.clear();
      scopedPaths.clear();
      scopedAssetIds.clear();
      return;
    }
    myImagesScope = nextScope;
    scopedUrls.clear();
    scopedPaths.clear();
    scopedAssetIds.clear();
    myImagesScope.querySelectorAll("img").forEach((image) => {
      [image.currentSrc, image.src].forEach((url) => {
        if (!isHttpUrl(url)) return;
        scopedUrls.add(url);
        scopedPaths.add(pathKey(url));
        const id = assetId(url);
        if (id) scopedAssetIds.add(id);
      });
    });
    myImagesScope.querySelectorAll("a[href]").forEach((link) => {
      if (!isHttpUrl(link.href)) return;
      scopedUrls.add(link.href);
      scopedPaths.add(pathKey(link.href));
      const id = assetId(link.href);
      if (id) scopedAssetIds.add(id);
    });
  };

  const addPending = (candidate, url, source) => {
    const existing = pending.get(url);
    pending.set(url, {
      url,
      name: candidate.name || existing?.name || "",
      prompt: candidate.prompt || existing?.prompt || "",
      createdAt: candidate.createdAt || existing?.createdAt || "",
      needsResolution: Boolean(candidate.needsResolution ?? existing?.needsResolution),
      source: source || existing?.source || "page"
    });
    if (flushTimer === null) flushTimer = window.setTimeout(flush, 120);
  };

  const enqueue = (candidate, source = "page") => {
    if (!candidate || !isHttpUrl(candidate.url)) return;
    let url;
    try {
      url = new URL(candidate.url, window.location.href).href;
    } catch {
      return;
    }
    if (!isHttpUrl(url)) return;
    if (isThumbnailUrl(url) && !candidate.needsResolution) return;
    if (candidate.needsResolution) {
      addPending({ ...candidate, url }, url, source);
      return;
    }
    if (!["dom", "restore"].includes(source) && !isInMyImagesScope(url)) {
      deferredCandidates.set(url, { ...candidate, url });
      return;
    }
    addPending(candidate, url, source);
  };

  const flush = () => {
    flushTimer = null;
    if (!pending.size) return;
    const items = [...pending.values()];
    pending.clear();
    sendRuntimeMessage({ type: "DISCOVER_IMAGES", items }, () => {
      void chrome.runtime.lastError;
    });
  };

  const findOpenButtonForImage = (image) => {
    const directButton = image?.closest("button");
    if (directButton && /open image|打开图片/i.test(directButton.getAttribute("aria-label") || "")) return directButton;
    let node = image?.parentElement;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      const button = node.querySelector('button[aria-label^="Open image:"], button[aria-label*="打开图片"]');
      if (button) return button;
    }
    return null;
  };

  const scanDom = () => {
    document.querySelectorAll('img[src*="/backend-api/estuary/content"]').forEach((image) => {
      const url = image.currentSrc || image.src;
      if (!isHttpUrl(url) || !isThumbnailUrl(url) || !estuaryFileId(url)) return;
      const openButton = findOpenButtonForImage(image);
      if (!openButton) return;
      const label = openButton?.getAttribute("aria-label") || image.alt || "";
      enqueue({
        url,
        name: label.replace(/^Open image:\s*/i, "").trim(),
        needsResolution: true
      }, "dom");
    });

    refreshScope();
    if (!myImagesScope) return;

    myImagesScope.querySelectorAll("img").forEach((image) => {
      const candidates = [
        image.dataset.original,
        image.dataset.full,
        image.dataset.download,
        image.dataset.source,
        image.dataset.url,
        ...[...(image.getAttribute("srcset") || "").split(",")]
          .map((item) => item.trim().split(/\s+/)[0]),
        image.currentSrc,
        image.src
      ].filter((url) => isHttpUrl(url) && !isThumbnailUrl(url));
      const url = candidates[0];
      if (url) {
        enqueue({
          url,
          name: image.alt || image.getAttribute("aria-label") || ""
        }, "dom");
      }
    });

    myImagesScope.querySelectorAll("a[href]").forEach((link) => {
      const href = link.href;
      if (!isHttpUrl(href)) return;
      const text = `${link.textContent || ""} ${link.getAttribute("download") || ""}`;
      const wrapsImage = Boolean(link.querySelector("img, picture, source"));
      const likelySource = /oaiusercontent|openaiusercontent|blob\.core\.windows\.net|\/files\//i.test(href);
      if (!isThumbnailUrl(href) && (wrapsImage || likelySource || /download|image|图片/i.test(text))) {
        enqueue({ url: href, name: text.trim().slice(0, 180) }, "dom");
      }
    });

    [...deferredCandidates.entries()].forEach(([url, candidate]) => {
      if (!isInMyImagesScope(url)) return;
      deferredCandidates.delete(url);
      addPending(candidate, url, "request");
    });
  };

  const isVisible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
      style.visibility !== "hidden" && Number(style.opacity) !== 0;
  };

  const findCardOpenButton = (fileId) => {
    const image = [...document.querySelectorAll('img[src*="/backend-api/estuary/content"]')]
      .find((item) => isThumbnailUrl(item.currentSrc || item.src) && estuaryFileId(item.currentSrc || item.src) === fileId);
    if (!image) return null;
    return findOpenButtonForImage(image);
  };

  const waitForOriginalImage = (fileId, timeoutMs = 7000) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const image = [...document.querySelectorAll('img[src*="/backend-api/estuary/content"]')].find((item) => {
        const src = item.currentSrc || item.src;
        return src && !isThumbnailUrl(src) && estuaryFileId(src) === fileId && isVisible(item);
      });
      if (image) {
        window.clearInterval(timer);
        resolve(image.currentSrc || image.src);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        window.clearInterval(timer);
        reject(new Error("等待原图地址超时"));
      }
    }, 120);
  });

  const closeImageViewer = async () => {
    const closeButton = [...document.querySelectorAll('button, [role="button"]')].find((element) => {
      if (!isVisible(element)) return false;
      const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`;
      return /close fullscreen|close image|关闭|返回/i.test(label);
    });
    if (closeButton) closeButton.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 180));
  };

  const resolveOriginalImage = async (thumbnailUrl) => {
    const fileId = estuaryFileId(thumbnailUrl);
    if (!fileId) throw new Error("无法识别图片文件 ID");
    const openButton = findCardOpenButton(fileId);
    if (!openButton) throw new Error("找不到对应的图片卡片，请滚动到该图片后重试");
    openButton.click();
    try {
      return await waitForOriginalImage(fileId);
    } finally {
      await closeImageViewer();
    }
  };

  const observeResources = () => {
    if (!window.PerformanceObserver) return;
    try {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => {
          if (entry.initiatorType === "img" && isInMyImagesScope(entry.name)) {
            enqueue({ url: entry.name }, "network");
          }
        });
      });
      observer.observe({ type: "resource", buffered: true });
    } catch {
      // Older Chromium versions may not support the resource observer options.
    }
  };

  const injectDownloadPanel = () => {
    if (document.getElementById("chatgpt-image-downloader-widget")) return;
    const host = document.createElement("div");
    host.id = "chatgpt-image-downloader-widget";
    host.style.cssText = "position:fixed;right:24px;bottom:24px;z-index:2147483647;pointer-events:none;";
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed;
          right: 0;
          bottom: 62px;
          width: 410px;
          height: min(690px, calc(100vh - 100px));
          overflow: hidden;
          border: 1px solid #ded9ed;
          border-radius: 16px;
          background: #fff;
          box-shadow: 0 18px 60px #241b4238, 0 0 0 4px #ffffffcc;
          pointer-events: auto;
          opacity: 0;
          visibility: hidden;
          transform: translateY(8px) scale(.98);
          transform-origin: bottom right;
          transition: opacity .16s ease, transform .16s ease, visibility .16s ease;
        }
        .panel.open {
          opacity: 1;
          visibility: visible;
          transform: translateY(0) scale(1);
        }
        iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
        .launcher {
          display: grid;
          place-items: center;
          width: 48px;
          height: 48px;
          padding: 0;
          border: 0;
          border-radius: 16px;
          color: #fff;
          background: #7058d8;
          box-shadow: 0 8px 24px #2d20544d, 0 0 0 4px #ffffffcc;
          cursor: pointer;
          font: 700 25px -apple-system, BlinkMacSystemFont, sans-serif;
          pointer-events: auto;
          transition: transform .16s ease, background .16s ease;
        }
        .launcher:hover { background: #5b44c7; transform: translateY(-2px); }
      </style>
      <div class="panel" aria-hidden="true"></div>
      <button class="launcher" type="button" aria-label="打开 ChatGPT 图片下载器" title="ChatGPT 图片下载">↓</button>
    `;
    document.documentElement.appendChild(host);

    const panel = shadow.querySelector(".panel");
    const launcher = shadow.querySelector(".launcher");
    let panelLoading = false;
    let openWhenReady = false;

    const ensurePanel = (openAfterLoad = false) => {
      openWhenReady ||= openAfterLoad;
      if (panel.querySelector("iframe")) {
        if (openWhenReady) {
          panel.classList.add("open");
          panel.setAttribute("aria-hidden", "false");
          openWhenReady = false;
        }
        return;
      }
      if (panelLoading) return;
      panelLoading = true;
      sendRuntimeMessage({ type: "OPEN_IN_PAGE_PANEL" }, (response) => {
        panelLoading = false;
        if (!response?.ok) {
          launcher.title = "请点击 Chrome 工具栏中的扩展图标打开下载器";
          return;
        }
        const iframe = document.createElement("iframe");
        iframe.title = "ChatGPT 图片下载器";
        iframe.src = chrome.runtime.getURL(`popup.html?embedded=1&tabId=${response.tabId}`);
        panel.appendChild(iframe);
        if (openWhenReady) {
          panel.classList.add("open");
          panel.setAttribute("aria-hidden", "false");
          openWhenReady = false;
        }
      });
    };

    launcher.addEventListener("click", () => {
      if (panel.classList.contains("open")) {
        panel.classList.remove("open");
        panel.setAttribute("aria-hidden", "true");
        return;
      }
      ensurePanel(true);
    });

    // Keep the panel hidden, but initialize it immediately so every page refresh
    // checks the selected directory and newly discovered images without another click.
    ensurePanel(false);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type !== PAGE_MESSAGE) return;
    enqueue(event.data.candidate, "request");
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "RESOLVE_ORIGINAL_IMAGE") return false;
    resolveOriginalImage(message.url)
      .then((url) => sendResponse({ ok: true, url }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "解析原图失败" }));
    return true;
  });

  const mutationObserver = new MutationObserver(() => scanDom());
  mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
  observeResources();
  scanDom();
  injectDownloadPanel();

  sendRuntimeMessage({ type: "CONTENT_READY" }, (response) => {
    void chrome.runtime.lastError;
    if (response?.state?.images) {
      response.state.images.forEach((image) => enqueue(image, "restore"));
    }
  });
})();
