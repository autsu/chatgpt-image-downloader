const TARGET_URL = /^https:\/\/chatgpt\.com\/images(?:[/?#]|$)/i;
const TAB_PREFIX = "tab-state:";
const SETTINGS_KEY = "settings";
const DOWNLOADED_KEY = "downloaded-image-keys";
const QUEUE_KEY = "download-queue";
const PAUSED_KEY = "download-paused";
const VOLATILE_QUERY_KEYS = new Set([
  "expires", "expiry", "se", "sig", "signature", "sp", "sv", "token", "access_token",
  "cache", "cachebust", "cache_bust", "t", "timestamp", "width", "height", "quality", "format"
]);

const runtimeState = new Map();
const runtimeQueue = [];
let settings = { folder: "ChatGPT Images", directoryMode: false };
let downloadedKeys = new Set();
let downloadPaused = false;
let initialized = false;

const stateStorageKey = (tabId) => `${TAB_PREFIX}${tabId}`;

const defaultState = () => ({
  images: [],
  updatedAt: Date.now(),
  downloading: 0,
  lastError: ""
});

const getStoredState = async (tabId) => {
  if (runtimeState.has(tabId)) return runtimeState.get(tabId);
  const result = await chrome.storage.session.get(stateStorageKey(tabId));
  const state = result[stateStorageKey(tabId)] || defaultState();
  runtimeState.set(tabId, state);
  return state;
};

const saveState = async (tabId, state) => {
  state.updatedAt = Date.now();
  runtimeState.set(tabId, state);
  await chrome.storage.session.set({ [stateStorageKey(tabId)]: state });
};

const loadPersistedData = async () => {
  if (initialized) return;
  const result = await chrome.storage.local.get([SETTINGS_KEY, DOWNLOADED_KEY]);
  settings = { ...settings, ...(result[SETTINGS_KEY] || {}) };
  downloadedKeys = new Set(result[DOWNLOADED_KEY] || []);
  const queueResult = await chrome.storage.session.get([QUEUE_KEY, PAUSED_KEY]);
  const savedQueue = queueResult[QUEUE_KEY] || [];
  runtimeQueue.splice(0, runtimeQueue.length, ...savedQueue);
  downloadPaused = Boolean(queueResult[PAUSED_KEY]);
  initialized = true;
};

const persistQueue = async () => {
  await chrome.storage.session.set({ [QUEUE_KEY]: runtimeQueue });
};

const broadcastPauseState = async () => {
  try {
    await chrome.runtime.sendMessage({ type: "DOWNLOAD_PAUSED", paused: downloadPaused });
  } catch {
    // No popup is open.
  }
};

const getDownloadImages = async () => {
  const states = await chrome.storage.session.get(null);
  const images = [];
  for (const [storageKey, state] of Object.entries(states)) {
    if (!storageKey.startsWith(TAB_PREFIX) || !state?.images) continue;
    const tabId = Number(storageKey.slice(TAB_PREFIX.length));
    state.images.forEach((image) => {
      if (image.downloadId != null && image.status === "downloading") images.push({ tabId, image });
    });
  }
  return images;
};

const pauseActiveDownloads = async () => {
  const active = await getDownloadImages();
  await Promise.all(active.map(({ image }) => chrome.downloads.pause(image.downloadId).catch(() => {})));
};

const resumeActiveDownloads = async () => {
  const active = await getDownloadImages();
  await Promise.all(active.map(({ image }) => chrome.downloads.resume(image.downloadId).catch(() => {})));
};

const rerouteActiveDownloads = async () => {
  const active = await getDownloadImages();
  const downloadIds = active.map(({ image }) => image.downloadId);
  for (const { tabId, image } of active) {
    const state = await getStoredState(tabId);
    const current = state.images.find((item) => item.key === image.key);
    if (!current) continue;
    current.status = "queued";
    current.downloadId = null;
    await saveState(tabId, state);
    await broadcast(tabId, state);
  }
  await Promise.all(downloadIds.map((downloadId) => chrome.downloads.cancel(downloadId).catch(() => {})));
};

const broadcast = async (tabId, state) => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "STATE_UPDATED", state });
  } catch {
    // The content script is not a consumer, and the popup may be closed.
  }
  try {
    await chrome.runtime.sendMessage({ type: "STATE_UPDATED", tabId, state });
  } catch {
    // No popup is open.
  }
};

const normalizeUrl = (rawUrl) => {
  try {
    const url = new URL(rawUrl);
    [...url.searchParams.keys()].forEach((key) => {
      if (VOLATILE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    });
    url.hash = "";
    return url.href;
  } catch {
    return String(rawUrl || "");
  }
};

const stableHash = (input) => {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const assetIdentity = (url) => {
  try {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname);
    const uuid = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0];
    if (uuid) return uuid.toLowerCase();
    const parts = path.split("/").filter(Boolean);
    const tail = parts.at(-1) || "";
    const cleanedTail = tail.replace(/\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i, "");
    if (cleanedTail.length >= 8 && /^[a-z0-9_-]+$/i.test(cleanedTail)) return cleanedTail.slice(-64);
    return stableHash(normalizeUrl(url));
  } catch {
    return stableHash(String(url));
  }
};

const filenameIdentity = (url) => {
  try {
    const decodedUrl = decodeURIComponent(String(url));
    const uuid = decodedUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
    if (uuid) return uuid.toLowerCase();

    const parsed = new URL(url);
    for (const key of ["id", "file_id", "fileId", "asset_id", "assetId", "image_id", "imageId"]) {
      const value = parsed.searchParams.get(key);
      if (value && /^[a-z0-9_-]{8,100}$/i.test(value)) return value;
    }

    const tail = decodeURIComponent(parsed.pathname).split("/").filter(Boolean).at(-1) || "";
    const cleanedTail = tail.replace(/\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/i, "");
    if (cleanedTail.length >= 8 && /^[a-z0-9_-]+$/i.test(cleanedTail)) return cleanedTail.slice(-80);

    const normalized = normalizeUrl(url);
    return `${stableHash(normalized)}${stableHash(`filename:${normalized}`)}`;
  } catch {
    const value = String(url || "");
    return `${stableHash(value)}${stableHash(`filename:${value}`)}`;
  }
};

const extensionFor = (url) => {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = pathname.match(/\.(png|jpe?g|webp|gif|avif|bmp|tiff?)$/);
    if (!match) return "png";
    return match[1] === "jpeg" ? "jpg" : match[1];
  } catch {
    return "png";
  }
};

const sanitizeSegment = (value) => String(value || "")
  .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/^\.+|\.+$/g, "")
  .slice(0, 100);

const sanitizeFolder = (value) => String(value || "")
  .replace(/[\\:*?"<>|\u0000-\u001f]/g, "")
  .split("/")
  .map((part) => sanitizeSegment(part))
  .filter(Boolean)
  .join("/")
  .slice(0, 180);

const isAbsolutePathLike = (value) => /^(?:[\\/]|~[\\/]|[a-z]:[\\/]|Users[\\/])/i.test(String(value || ""));

const getFilename = (url) => {
  const id = filenameIdentity(url);
  const extension = extensionFor(url);
  return `ChatGPT-${id}.${extension}`;
};

const candidateScore = (image) => {
  let score = 0;
  const value = `${image.url} ${image.source}`.toLowerCase();
  if (image.source === "request") score += 40;
  if (image.source === "dom") score += 20;
  if (/original|full|download|large/.test(value)) score += 20;
  if (/thumbnail|thumb|small|preview|width=\d{1,3}/.test(value)) score -= 20;
  return score;
};

const mergeImages = (state, items) => {
  let changed = false;
  const byKey = new Map(state.images.map((image) => [image.key, image]));
  items.slice(0, 500).forEach((candidate) => {
    if (!candidate?.url || !/^https?:\/\//i.test(candidate.url)) return;
    const normalizedUrl = normalizeUrl(candidate.url);
    const key = assetIdentity(normalizedUrl);
    const existing = byKey.get(key);
    const incoming = {
      key,
      url: candidate.url,
      filename: getFilename(normalizedUrl),
      name: sanitizeSegment(candidate.name),
      prompt: String(candidate.prompt || "").slice(0, 300),
      source: candidate.source || "page",
      firstSeenAt: existing?.firstSeenAt || Date.now(),
      lastSeenAt: Date.now(),
      selected: existing?.selected ?? true,
      status: existing?.status || "ready",
      downloadId: existing?.downloadId || null,
      error: existing?.error || ""
    };
    if (!existing) {
      byKey.set(key, incoming);
      changed = true;
      return;
    }
    const preferredUrl = candidateScore(incoming) >= candidateScore(existing) ? incoming.url : existing.url;
    const nextFilename = getFilename(preferredUrl);
    if (existing.url !== preferredUrl || existing.lastSeenAt !== incoming.lastSeenAt || existing.filename !== nextFilename) {
      existing.url = preferredUrl;
      existing.filename = nextFilename;
      existing.lastSeenAt = incoming.lastSeenAt;
      existing.name = incoming.name || existing.name;
      existing.prompt = incoming.prompt || existing.prompt;
      existing.source = incoming.source || existing.source;
      changed = true;
    }
  });
  if (changed) state.images = [...byKey.values()].sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  return changed;
};

const updateTabAction = async (tabId, url) => {
  try {
    if (TARGET_URL.test(url || "")) await chrome.action.enable(tabId);
    else await chrome.action.disable(tabId);
  } catch {
    // Tabs can disappear while navigation events are being delivered.
  }
};

const activeDownloadFor = async (key) => {
  for (const state of runtimeState.values()) {
    const image = state.images.find((item) => item.key === key);
    if (image?.status === "downloading") return true;
  }
  const states = await chrome.storage.session.get(null);
  return Object.entries(states).some(([storageKey, state]) => storageKey.startsWith(TAB_PREFIX) && state?.images?.some((item) => item.key === key && item.status === "downloading"));
};

const findImage = async (tabId, key) => {
  const state = await getStoredState(tabId);
  return { state, image: state.images.find((item) => item.key === key) };
};

const setImageStatus = async (tabId, key, patch) => {
  const { state, image } = await findImage(tabId, key);
  if (!image) return;
  Object.assign(image, patch);
  state.downloading = state.images.filter((item) => ["queued", "downloading"].includes(item.status)).length;
  await saveState(tabId, state);
  await broadcast(tabId, state);
};

const pumpQueue = async () => {
  await loadPersistedData();
  if (downloadPaused) return;
  const next = runtimeQueue[0];
  if (!next) return;
  if (await activeDownloadFor(next.key)) return;
  const { state, image } = await findImage(next.tabId, next.key);
  if (!image || !["queued", "downloading"].includes(image.status)) {
    runtimeQueue.shift();
    await persistQueue();
    return pumpQueue();
  }
  const folder = sanitizeFolder(settings.folder);
  const filename = folder ? `${folder}/${image.filename}` : image.filename;
  try {
    await setImageStatus(next.tabId, next.key, { status: "downloading", error: "" });
    const downloadId = await chrome.downloads.download({
      url: image.url,
      filename,
      conflictAction: "skip",
      saveAs: false
    });
    await setImageStatus(next.tabId, next.key, { downloadId, status: "downloading" });
  } catch (error) {
    const errorMessage = error?.message || "下载失败";
    const alreadyExists = /FILE_EXISTS|file exists/i.test(errorMessage);
    await setImageStatus(next.tabId, next.key, {
      status: alreadyExists ? "skipped" : "error",
      error: alreadyExists ? "" : errorMessage
    });
    runtimeQueue.shift();
    await persistQueue();
    await pumpQueue();
  }
};

const markDownloadChanged = async (downloadId, delta) => {
  await loadPersistedData();
  const states = await chrome.storage.session.get(null);
  for (const [storageKey, state] of Object.entries(states)) {
    if (!storageKey.startsWith(TAB_PREFIX) || !state?.images) continue;
    const tabId = Number(storageKey.slice(TAB_PREFIX.length));
    const image = state.images.find((item) => item.downloadId === downloadId);
    if (!image) continue;
    if (delta.state?.current === "complete") {
      image.status = "complete";
      image.error = "";
      downloadedKeys.add(image.key);
      await chrome.storage.local.set({ [DOWNLOADED_KEY]: [...downloadedKeys].slice(-5000) });
      state.downloading = state.images.filter((item) => ["queued", "downloading"].includes(item.status)).length;
      await saveState(tabId, state);
      await broadcast(tabId, state);
      const queued = runtimeQueue.findIndex((item) => item.key === image.key && item.tabId === tabId);
      if (queued === 0) runtimeQueue.shift();
      else if (queued > 0) runtimeQueue.splice(queued, 1);
      await persistQueue();
      await pumpQueue();
      return;
    }
    if (delta.error?.current) {
      const alreadyExists = delta.error.current === "FILE_EXISTS";
      image.status = alreadyExists ? "skipped" : "error";
      image.error = alreadyExists ? "" : delta.error.current;
      state.downloading = state.images.filter((item) => ["queued", "downloading"].includes(item.status)).length;
      await saveState(tabId, state);
      await broadcast(tabId, state);
      const queueIndex = runtimeQueue.findIndex((item) => item.key === image.key && item.tabId === tabId);
      if (queueIndex >= 0) runtimeQueue.splice(queueIndex, 1);
      await persistQueue();
      await pumpQueue();
      return;
    }
  }
};

const startDownloads = async (tabId, keys) => {
  await loadPersistedData();
  if (!settings.directoryMode && isAbsolutePathLike(settings.folder)) {
    throw new Error("手动输入的绝对路径无法直接使用，请点击“选择文件夹”授权目标目录");
  }
  const state = await getStoredState(tabId);
  const wanted = new Set(keys || []);
  state.images.forEach((image) => {
    if (!wanted.has(image.key) || ["queued", "downloading"].includes(image.status)) return;
    image.status = "queued";
    image.error = "";
    if (!runtimeQueue.some((item) => item.tabId === tabId && item.key === image.key)) runtimeQueue.push({ tabId, key: image.key });
  });
  await saveState(tabId, state);
  await persistQueue();
  await broadcast(tabId, state);
  await pumpQueue();
  return state;
};

chrome.runtime.onInstalled.addListener(async () => {
  await loadPersistedData();
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => updateTabAction(tab.id, tab.url)));
  await pumpQueue();
});

chrome.runtime.onStartup.addListener(() => {
  void pumpQueue();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading") void updateTabAction(tabId, changeInfo.url || tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateTabAction(tabId, tab.url);
  } catch {
    // The active tab may close before it can be inspected.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  runtimeState.delete(tabId);
  void chrome.storage.session.remove(stateStorageKey(tabId));
});

chrome.downloads.onChanged.addListener((delta) => {
  void markDownloadChanged(delta.id, delta);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const run = async () => {
    await loadPersistedData();
    if (message.type === "CONTENT_READY" && tabId != null) {
      const state = defaultState();
      await saveState(tabId, state);
      return { state };
    }
    if (message.type === "DISCOVER_IMAGES" && tabId != null) {
      const state = await getStoredState(tabId);
      if (mergeImages(state, message.items || [])) {
        await saveState(tabId, state);
        await broadcast(tabId, state);
      }
      return { ok: true, count: state.images.length };
    }
    if (message.type === "GET_STATE") {
      const currentTabId = message.tabId ?? tabId;
      if (currentTabId == null) return { state: defaultState(), settings };
      return { state: await getStoredState(currentTabId), settings };
    }
    if (message.type === "GET_DOWNLOAD_STATUS") {
      return { paused: downloadPaused };
    }
    if (message.type === "SET_SETTINGS") {
      if (!message.directoryMode && isAbsolutePathLike(message.folder)) {
        return { error: "手动输入的绝对路径无法直接使用，请点击“选择文件夹”" };
      }
      const nextSettings = {
        ...settings,
        folder: sanitizeFolder(message.folder),
        directoryMode: Boolean(message.directoryMode)
      };
      const targetChanged = settings.folder !== nextSettings.folder || settings.directoryMode !== nextSettings.directoryMode;
      settings = nextSettings;
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      if (targetChanged && downloadPaused) await rerouteActiveDownloads();
      if (settings.directoryMode) {
        try {
          await chrome.runtime.sendMessage({ type: "DIRECTORY_SELECTED", settings });
        } catch {
          // The other popup may not be open.
        }
      }
      return { settings };
    }
    if (message.type === "SET_DOWNLOAD_PAUSED") {
      downloadPaused = Boolean(message.paused);
      await chrome.storage.session.set({ [PAUSED_KEY]: downloadPaused });
      if (downloadPaused) await pauseActiveDownloads();
      else {
        await resumeActiveDownloads();
        await pumpQueue();
      }
      await broadcastPauseState();
      return { paused: downloadPaused };
    }
    if (message.type === "OPEN_FOLDER_PICKER") {
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("folder-picker.html") });
      return { ok: true, tabId: tab.id };
    }
    if (message.type === "OPEN_IN_PAGE_PANEL") {
      return { ok: tabId != null, tabId };
    }
    if (message.type === "OPEN_SETTINGS_PAGE") {
      const url = chrome.runtime.getURL("settings.html");
      const tabs = await chrome.tabs.query({ url });
      const existing = tabs.find((tab) => tab.id != null);
      if (existing?.id != null) {
        await chrome.tabs.update(existing.id, { active: true });
        return { ok: true, tabId: existing.id };
      }
      const created = await chrome.tabs.create({ url, active: true });
      return { ok: true, tabId: created.id };
    }
    if (message.type === "DIRECTORY_SELECTED") {
      const targetChanged = settings.folder !== sanitizeFolder(message.name) || !settings.directoryMode;
      settings = {
        ...settings,
        folder: sanitizeFolder(message.name),
        directoryMode: true
      };
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
      if (targetChanged && downloadPaused) await rerouteActiveDownloads();
      try {
        await chrome.runtime.sendMessage({ type: "DIRECTORY_SELECTED", settings });
      } catch {
        // The main popup may be closed while the picker is being used.
      }
      return { settings };
    }
    if (message.type === "DIRECT_DOWNLOAD_STATUS" && (message.tabId ?? tabId) != null) {
      const currentTabId = message.tabId ?? tabId;
      const state = await getStoredState(currentTabId);
      const keys = new Set(message.keys || []);
      const status = message.status || "ready";
      state.images.forEach((image) => {
        if (!keys.has(image.key)) return;
        image.status = status;
        image.error = message.error || "";
        if (status === "ready") {
          image.selected = true;
          image.downloadId = null;
        }
        if (status === "complete") {
          image.selected = false;
          downloadedKeys.add(image.key);
        }
      });
      state.downloading = state.images.filter((item) => ["queued", "downloading"].includes(item.status)).length;
      await saveState(currentTabId, state);
      if (status === "complete") {
        await chrome.storage.local.set({ [DOWNLOADED_KEY]: [...downloadedKeys].slice(-5000) });
      }
      await broadcast(currentTabId, state);
      return { state };
    }
    if (message.type === "SET_SELECTIONS" && (message.tabId ?? tabId) != null) {
      const currentTabId = message.tabId ?? tabId;
      const state = await getStoredState(currentTabId);
      const selections = message.selections || {};
      state.images.forEach((image) => {
        if (Object.hasOwn(selections, image.key)) image.selected = Boolean(selections[image.key]);
      });
      await saveState(currentTabId, state);
      await broadcast(currentTabId, state);
      return { state };
    }
    if (message.type === "DOWNLOAD" && (message.tabId ?? tabId) != null) {
      const currentTabId = message.tabId ?? tabId;
      const state = await startDownloads(currentTabId, message.keys || []);
      return { state };
    }
    if (message.type === "RETRY" && (message.tabId ?? tabId) != null) {
      const currentTabId = message.tabId ?? tabId;
      const state = await startDownloads(currentTabId, message.keys || []);
      return { state };
    }
    return { ok: false };
  };
  run().then(sendResponse).catch((error) => sendResponse({ error: error?.message || "操作失败" }));
  return true;
});
