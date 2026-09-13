let currentTabId = null;
let currentState = { images: [] };
let currentSettings = { folder: "ChatGPT Images", directoryMode: false };
let directoryHandle = null;
let directoryPermissionGranted = false;
let downloadPaused = false;
const activeDirectKeys = new Set();
const resumeWaiters = [];
const liveProgress = new Map();
const chromeProgressSamples = new Map();
const directoryCheckingKeys = new Set();
const directoryCheckedKeys = new Set();
const MIN_IMAGE_BYTES = 64 * 1024;
const MIN_IMAGE_EDGE = 512;
const DIRECTORY_SCAN_CONCURRENCY = 8;
let toastTimer = null;
let directoryScanState = null;
let directoryScanChain = Promise.resolve();
let directoryScanTimer = null;
const embeddedTabId = Number(new URLSearchParams(location.search).get("tabId")) || null;

const $ = (selector) => document.querySelector(selector);

const send = (message) => new Promise((resolve) => {
  chrome.runtime.sendMessage(message, (response) => {
    void chrome.runtime.lastError;
    resolve(response || {});
  });
});

const openHandleDb = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("chatgpt-image-downloader", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("handles");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const saveDirectoryHandle = async (handle) => {
  const db = await openHandleDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("handles", "readwrite");
    transaction.objectStore("handles").put(handle, "selected-directory");
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
};

const loadDirectoryHandle = async () => {
  try {
    const db = await openHandleDb();
    const handle = await new Promise((resolve, reject) => {
      const request = db.transaction("handles", "readonly").objectStore("handles").get("selected-directory");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
};

const hasDirectoryPermission = async (handle) => {
  if (!handle) return false;
  try {
    return await handle.queryPermission?.({ mode: "readwrite" }) === "granted";
  } catch {
    return false;
  }
};

const showToast = (message) => {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
};

const updatePauseButton = () => {
  const button = $("#pause-download");
  button.textContent = downloadPaused ? "恢复下载" : "暂停下载";
  button.classList.toggle("paused", downloadPaused);
};

const waitForResume = async () => {
  if (!downloadPaused) return;
  await new Promise((resolve) => resumeWaiters.push(resolve));
};

const formatBytes = (bytes) => {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "--";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
};

const formatSpeed = (bytesPerSecond) => {
  const value = Number(bytesPerSecond);
  if (!Number.isFinite(value) || value <= 0) return "--/s";
  return `${formatBytes(value)}/s`;
};

const getRemoteMetadata = async (url) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) return { size: null, contentType: "" };
    const contentLength = Number(response.headers.get("content-length"));
    return {
      size: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null,
      contentType: (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
    };
  } catch {
    return { size: null, contentType: "" };
  } finally {
    window.clearTimeout(timer);
  }
};

const rejectedByMetadata = ({ size, contentType }) => {
  if (contentType === "image/webp") return "WebP 缩略图";
  if (size != null && size < MIN_IMAGE_BYTES) return `小于 ${formatBytes(MIN_IMAGE_BYTES)}`;
  return "";
};

const inspectBlob = async (blob) => {
  let width = 0;
  let height = 0;
  let contentType = (blob.type || "").split(";")[0].trim().toLowerCase();
  try {
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const isWebp = header.length >= 12
      && String.fromCharCode(...header.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...header.slice(8, 12)) === "WEBP";
    if (isWebp) contentType = "image/webp";
  } catch {
    // Fall back to the response MIME type and decoded dimensions.
  }
  try {
    const bitmap = await createImageBitmap(blob);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch {
    // Size and MIME checks still work if decoding fails.
  }
  let reason = rejectedByMetadata({ size: blob.size, contentType });
  if (!reason && width > 0 && height > 0 && (width < MIN_IMAGE_EDGE || height < MIN_IMAGE_EDGE)) {
    reason = `尺寸仅 ${width}×${height}`;
  }
  return { size: blob.size, contentType, width, height, reason };
};

const existingFileMatchesSource = async (directory, image, metadata = null) => {
  let fileHandle;
  try {
    fileHandle = await directory.getFileHandle(image.filename, { create: false });
  } catch (error) {
    if (error?.name === "NotFoundError") return { exists: false, matches: false, metadata };
    throw error;
  }

  const localFile = await fileHandle.getFile();
  const remoteMetadata = metadata || await getRemoteMetadata(image.url);
  // 没有 Content-Length 时，按同名文件跳过，避免为校验而重复下载整个文件。
  return {
    exists: true,
    matches: remoteMetadata.size == null || localFile.size === remoteMetadata.size,
    localSize: localFile.size,
    localFile,
    metadata: remoteMetadata
  };
};

const statusText = (image) => {
  if (directoryCheckingKeys.has(image.key)) return "检查目标文件夹…";
  if (image.status === "skipped") return "已存在，跳过";
  if (image.status === "filtered") return image.error || "已过滤小图";
  if (image.status === "complete") return "下载完成";
  if (image.status === "downloading") return "下载中";
  if (image.status === "queued") return "排队中";
  if (image.status === "error") return image.error || "下载失败";
  return "待下载";
};

const render = () => {
  const images = currentState.images || [];
  const terminalStatuses = new Set(["complete", "skipped", "filtered"]);
  const selected = images.filter((image) => image.selected && !terminalStatuses.has(image.status));
  const active = images.filter((image) => ["queued", "downloading"].includes(image.status)).length;
  $("#scanned-count").textContent = images.length;
  $("#selected-count").textContent = selected.length;
  $("#folder-input").value = currentSettings.directoryMode && directoryHandle
    ? currentSettings.folder || directoryHandle.name
    : "未选择文件夹（Chrome 默认下载目录）";
  $("#folder-input").readOnly = true;
  $("#folder-mode-hint").textContent = currentSettings.directoryMode && directoryHandle
    ? directoryPermissionGranted
      ? `已授权“${currentSettings.folder || "目标文件夹"}”，下载会直接保存到该文件夹。`
      : `已选择“${currentSettings.folder || "目标文件夹"}”，但 Chrome 需要重新授权。点击齿轮即可完成。`
    : "尚未选择目录，当前会使用 Chrome 默认下载目录。点击齿轮设置保存目录。";
  $("#connection-dot").classList.add("connected");
  updatePauseButton();
  $("#scan-meta").textContent = directoryScanState
    ? `检查目录 ${directoryScanState.done}/${directoryScanState.total}`
    : downloadPaused
      ? "下载已暂停"
      : active ? `${active} 张正在下载` : "仅扫描“我的图片”区域，向下滚动继续";
  $("#list-subtitle").textContent = selected.length === images.filter((image) => !terminalStatuses.has(image.status)).length ? "全部选中" : `${selected.length} 张已选中`;
  $("#download-all").disabled = Boolean(directoryScanState);
  $("#download-selected").disabled = Boolean(directoryScanState);

  const list = $("#image-list");
  list.querySelectorAll(".image-row").forEach((row) => row.remove());
  $("#empty-state").hidden = images.length > 0;

  const fragment = document.createDocumentFragment();
  images.forEach((image) => {
    const row = document.createElement("div");
    row.className = "image-row";
    row.dataset.key = image.key;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(image.selected);
    checkbox.disabled = terminalStatuses.has(image.status) || directoryCheckingKeys.has(image.key);
    checkbox.dataset.action = "select";
    checkbox.setAttribute("aria-label", `选择 ${image.filename}`);

    const thumbnail = document.createElement("img");
    thumbnail.className = "thumb";
    thumbnail.src = image.url;
    thumbnail.alt = image.name || image.filename;
    thumbnail.loading = "lazy";
    thumbnail.referrerPolicy = "no-referrer";
    thumbnail.addEventListener("error", () => {
      thumbnail.removeAttribute("src");
    }, { once: true });

    const info = document.createElement("div");
    info.className = "image-info";
    const name = document.createElement("div");
    name.className = "image-name";
    name.title = image.filename;
    name.textContent = image.filename;
    const status = document.createElement("span");
    status.className = `image-status ${image.status || ""}`;
    status.textContent = statusText(image);
    info.append(name, status);

    if (image.status === "downloading") {
      const progress = liveProgress.get(image.key) || {};
      const progressTrack = document.createElement("div");
      progressTrack.className = `progress-track${progress.total > 0 ? "" : " indeterminate"}`;
      const progressFill = document.createElement("div");
      progressFill.className = "progress-fill";
      progressFill.style.width = progress.total > 0
        ? `${Math.min(100, (progress.received / progress.total) * 100).toFixed(1)}%`
        : "35%";
      progressTrack.append(progressFill);
      const progressMeta = document.createElement("div");
      progressMeta.className = "progress-meta";
      progressMeta.textContent = progress.total > 0
        ? `${Math.floor((progress.received / progress.total) * 100)}% · ${formatBytes(progress.received)} / ${formatBytes(progress.total)} · ${formatSpeed(progress.speed)}`
        : `${formatBytes(progress.received || 0)} · ${formatSpeed(progress.speed)}`;
      info.append(progressTrack, progressMeta);
    }

    row.append(checkbox, thumbnail, info);
    if (image.status === "error") {
      const retry = document.createElement("button");
      retry.className = "retry-button";
      retry.type = "button";
      retry.dataset.action = "retry";
      retry.textContent = "重试";
      row.append(retry);
    }
    fragment.append(row);
  });
  list.append(fragment);
}

const isImagesTab = (tab) => /^https:\/\/chatgpt\.com\/images(?:[/?#]|$)/i.test(tab?.url || "");

const getCurrentTab = async () => {
  if (embeddedTabId != null) {
    try {
      const sourceTab = await chrome.tabs.get(embeddedTabId);
      if (sourceTab) return sourceTab;
    } catch {
      // The source tab may have been closed.
    }
  }

  const activeTabs = await chrome.tabs.query({ active: true });
  const imagesTab = activeTabs.find(isImagesTab);
  if (imagesTab) return imagesTab;

  const currentWindowTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return currentWindowTabs[0];
};

const markDirectStatus = async (keys, status, error = "", details = {}) => {
  if (["ready", "skipped", "filtered", "complete", "error"].includes(status)) {
    keys.forEach((key) => liveProgress.delete(key));
  }
  const response = await send({
    type: "DIRECT_DOWNLOAD_STATUS",
    tabId: currentTabId,
    keys,
    status,
    error,
    details
  });
  if (response.state) {
    currentState = response.state;
    render();
  }
  return response;
};

const updateProgressView = (key, progress) => {
  liveProgress.set(key, progress);
  const row = [...document.querySelectorAll(".image-row")].find((element) => element.dataset.key === key);
  if (!row) return;
  const fill = row.querySelector(".progress-fill");
  const meta = row.querySelector(".progress-meta");
  const track = row.querySelector(".progress-track");
  if (!fill || !meta || !track) return;
  const hasTotal = progress.total > 0;
  track.classList.toggle("indeterminate", !hasTotal);
  fill.style.width = hasTotal
    ? `${Math.min(100, (progress.received / progress.total) * 100).toFixed(1)}%`
    : "35%";
  meta.textContent = hasTotal
    ? `${Math.floor((progress.received / progress.total) * 100)}% · ${formatBytes(progress.received)} / ${formatBytes(progress.total)} · ${formatSpeed(progress.speed)}`
    : `${formatBytes(progress.received)} · ${formatSpeed(progress.speed)}`;
};

const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
};

const reconcileDirectoryFilesNow = async (keys) => {
  const handle = directoryHandle;
  if (!currentSettings.directoryMode || !handle || !directoryPermissionGranted || currentTabId == null) return [];
  const wanted = new Set(keys || []);
  const images = currentState.images.filter((image) =>
    wanted.has(image.key) && !["queued", "downloading"].includes(image.status));
  if (!images.length) return [];

  images.forEach((image) => directoryCheckingKeys.add(image.key));
  directoryScanState = { done: 0, total: images.length };
  render();

  try {
    const results = await mapWithConcurrency(images, DIRECTORY_SCAN_CONCURRENCY, async (image) => {
      try {
        const existing = await existingFileMatchesSource(handle, image);
        if (existing.localFile && existing.localFile.size < MIN_IMAGE_BYTES) {
          const localInspection = await inspectBlob(existing.localFile);
          return {
            key: image.key,
            status: "filtered",
            details: {
              error: `已过滤：${localInspection.reason || "文件过小"} · ${localInspection.width || "?"}×${localInspection.height || "?"} · ${formatBytes(localInspection.size)}`,
              size: localInspection.size,
              contentType: localInspection.contentType,
              width: localInspection.width,
              height: localInspection.height
            }
          };
        }
        const existingReason = rejectedByMetadata(existing.metadata || {});
        if (existingReason) {
          return {
            key: image.key,
            status: "filtered",
            details: {
              error: `已过滤：${existingReason}${existing.metadata?.size == null ? "" : ` · ${formatBytes(existing.metadata.size)}`}`,
              size: existing.metadata?.size,
              contentType: existing.metadata?.contentType || ""
            }
          };
        }
        if (existing.matches) return { key: image.key, status: "skipped" };

        const metadata = existing.metadata || await getRemoteMetadata(image.url);
        const reason = rejectedByMetadata(metadata);
        if (reason) {
          return {
            key: image.key,
            status: "filtered",
            details: {
              error: `已过滤：${reason}${metadata.size == null ? "" : ` · ${formatBytes(metadata.size)}`}`,
              size: metadata.size,
              contentType: metadata.contentType
            }
          };
        }
        return { key: image.key, status: "ready" };
      } catch (error) {
        return { key: image.key, status: "ready", scanError: error?.message || "目录检查失败" };
      } finally {
        directoryScanState.done += 1;
        const scanMeta = $("#scan-meta");
        if (scanMeta) scanMeta.textContent = `检查目录 ${directoryScanState.done}/${directoryScanState.total}`;
      }
    });

    const grouped = new Map();
    results.forEach((result) => directoryCheckedKeys.add(result.key));
    results.forEach((result) => {
      if (!grouped.has(result.status)) grouped.set(result.status, []);
      grouped.get(result.status).push(result);
    });
    for (const status of ["skipped", "filtered", "ready"]) {
      const group = grouped.get(status) || [];
      if (!group.length) continue;
      const details = Object.fromEntries(group.filter((item) => item.details).map((item) => [item.key, item.details]));
      await markDirectStatus(group.map((item) => item.key), status, "", details);
    }
    return results;
  } finally {
    images.forEach((image) => directoryCheckingKeys.delete(image.key));
    directoryScanState = null;
    render();
  }
};

const reconcileDirectoryFiles = (keys) => {
  const task = () => reconcileDirectoryFilesNow(keys);
  const result = directoryScanChain.then(task, task);
  directoryScanChain = result.catch(() => []);
  return result;
};

const refreshExistingStatuses = async () => {
  const keys = currentState.images.map((image) => image.key);
  return reconcileDirectoryFiles(keys);
};

const scheduleDirectoryScan = () => {
  if (!currentSettings.directoryMode || !directoryHandle || !directoryPermissionGranted) return;
  window.clearTimeout(directoryScanTimer);
  directoryScanTimer = window.setTimeout(() => {
    const keys = currentState.images
      .filter((image) => !directoryCheckedKeys.has(image.key) && !["queued", "downloading"].includes(image.status))
      .map((image) => image.key);
    if (keys.length) void reconcileDirectoryFiles(keys);
  }, 250);
};

const fetchImageBlob = async (image) => {
  const response = await fetch(image.url, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(total) && total > 0 ? total : 0;
  if (!response.body) {
    const blob = await response.blob();
    updateProgressView(image.key, { received: blob.size, total: totalBytes || blob.size, speed: 0 });
    return blob;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastBytes = 0;
  let lastTime = performance.now();
  let smoothedSpeed = 0;
  updateProgressView(image.key, { received: 0, total: totalBytes, speed: 0 });
  while (true) {
    await waitForResume();
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const now = performance.now();
    if (now - lastTime >= 200 || (totalBytes > 0 && received >= totalBytes)) {
      const currentSpeed = ((received - lastBytes) * 1000) / Math.max(1, now - lastTime);
      smoothedSpeed = smoothedSpeed ? smoothedSpeed * 0.65 + currentSpeed * 0.35 : currentSpeed;
      updateProgressView(image.key, { received, total: totalBytes, speed: smoothedSpeed });
      lastBytes = received;
      lastTime = now;
    }
  }
  updateProgressView(image.key, { received, total: totalBytes || received, speed: smoothedSpeed });
  return new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
};

const downloadToDirectory = async (keys, handle) => {
  const uniqueKeys = [...new Set(keys)].filter((key) => !activeDirectKeys.has(key));
  if (!uniqueKeys.length) {
    showToast("这些图片已经在下载或已处理，已跳过重复操作");
    return;
  }
  uniqueKeys.forEach((key) => activeDirectKeys.add(key));
  const initialHandle = directoryHandle || handle;
  if (!(await hasDirectoryPermission(initialHandle))) {
    uniqueKeys.forEach((key) => activeDirectKeys.delete(key));
    directoryPermissionGranted = false;
    render();
    await openSettingsPage("reauthorize");
    showToast("目录权限已过期，已打开授权页");
    return;
  }
  directoryPermissionGranted = true;
  showToast(`正在检查目标文件夹中的 ${uniqueKeys.length} 张图片…`);
  await reconcileDirectoryFiles(uniqueKeys);
  const downloadKeys = uniqueKeys.filter((key) => {
    const image = currentState.images.find((item) => item.key === key);
    return image && !["complete", "skipped", "filtered", "queued", "downloading"].includes(image.status);
  });
  if (!downloadKeys.length) {
    uniqueKeys.forEach((key) => activeDirectKeys.delete(key));
    showToast("目标文件夹中已存在这些图片，或图片已被过滤");
    return;
  }
  await markDirectStatus(downloadKeys, "queued");
  let completed = 0;
  let skipped = 0;
  let filtered = 0;
  try {
    for (const key of downloadKeys) {
      await waitForResume();
      const image = currentState.images.find((item) => item.key === key);
      if (!image) continue;
      try {
        liveProgress.set(key, { received: 0, total: 0, speed: 0 });
        await markDirectStatus([key], "downloading");
        const blob = await fetchImageBlob(image);
        const inspection = await inspectBlob(blob);
        if (inspection.reason) {
          filtered += 1;
          await markDirectStatus([key], "filtered", "", {
            [key]: {
              error: `已过滤：${inspection.reason} · ${inspection.width || "?"}×${inspection.height || "?"} · ${formatBytes(inspection.size)}`,
              size: inspection.size,
              contentType: inspection.contentType,
              width: inspection.width,
              height: inspection.height
            }
          });
          continue;
        }

        const currentHandle = directoryHandle;
        if (!currentHandle) throw new Error("请先选择保存文件夹");
        const racedExisting = await existingFileMatchesSource(currentHandle, image, {
          size: blob.size,
          contentType: inspection.contentType
        });
        if (racedExisting.matches) {
          skipped += 1;
          await markDirectStatus([key], "skipped");
          continue;
        }
        const fileHandle = await currentHandle.getFileHandle(image.filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        completed += 1;
        await markDirectStatus([key], "complete");
      } catch (error) {
        await markDirectStatus([key], "error", error?.message || "写入文件夹失败");
      }
    }
  } finally {
    uniqueKeys.forEach((key) => activeDirectKeys.delete(key));
  }
  showToast(`已保存 ${completed} 张，已存在 ${skipped} 张，过滤小图 ${filtered} 张`);
};

const togglePause = async () => {
  const response = await send({ type: "SET_DOWNLOAD_PAUSED", paused: !downloadPaused });
  if (typeof response.paused === "boolean") {
    downloadPaused = response.paused;
    updatePauseButton();
    if (!downloadPaused) {
      while (resumeWaiters.length) resumeWaiters.shift()();
    }
    showToast(downloadPaused ? "下载已暂停" : "下载已恢复");
  }
};

const updateSelections = async (key, checked) => {
  const response = await send({ type: "SET_SELECTIONS", tabId: currentTabId, selections: { [key]: checked } });
  if (response.state) {
    currentState = response.state;
    render();
  }
};

const download = async (keys, message) => {
  if (!keys.length) {
    showToast(message);
    return;
  }
  if (currentSettings.directoryMode && directoryHandle) {
    await downloadToDirectory(keys, directoryHandle);
    return;
  }
  const response = await send({ type: "DOWNLOAD", tabId: currentTabId, keys });
  if (response.error) showToast(response.error);
  if (response.state) {
    currentState = response.state;
    render();
  }
  showToast(`已加入 ${keys.length} 张图片的下载队列`);
};

const openSettingsPage = async (mode = "settings") => {
  const response = await send({ type: "OPEN_SETTINGS_PAGE", sourceTabId: currentTabId, mode });
  if (!response.ok) showToast("打开设置页失败");
  return response;
};

const pollChromeDownloadProgress = async () => {
  const active = currentState.images.filter((image) => image.status === "downloading" && image.downloadId != null && !activeDirectKeys.has(image.key));
  const now = performance.now();
  await Promise.all(active.map(async (image) => {
    try {
      const [item] = await chrome.downloads.search({ id: image.downloadId });
      if (!item) return;
      const previous = chromeProgressSamples.get(image.key);
      const elapsed = previous ? Math.max(1, now - previous.time) : 0;
      const speed = previous ? ((item.bytesReceived - previous.bytes) * 1000) / elapsed : 0;
      chromeProgressSamples.set(image.key, { bytes: item.bytesReceived, time: now });
      updateProgressView(image.key, {
        received: item.bytesReceived,
        total: item.totalBytes > 0 ? item.totalBytes : 0,
        speed: Math.max(0, speed)
      });
    } catch {
      // The download can finish between the state read and this query.
    }
  }));
  const activeKeys = new Set(active.map((image) => image.key));
  [...chromeProgressSamples.keys()].forEach((key) => {
    if (!activeKeys.has(key)) chromeProgressSamples.delete(key);
  });
};

const selectAll = async (checked) => {
  const selections = {};
  currentState.images.forEach((image) => {
    if (!["complete", "skipped", "filtered"].includes(image.status)) selections[image.key] = checked;
  });
  const response = await send({ type: "SET_SELECTIONS", tabId: currentTabId, selections });
  if (response.state) {
    currentState = response.state;
    render();
  }
};

document.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  const row = event.target.closest(".image-row");
  if (action === "select" && row) await updateSelections(row.dataset.key, event.target.checked);
  if (action === "retry" && row) await download([row.dataset.key], "该图片已在下载队列中");
});

$("#open-settings").addEventListener("click", async () => {
  await openSettingsPage();
});
$("#download-all").addEventListener("click", async () => {
  const includeSkippedForDirectoryRescan = currentSettings.directoryMode && directoryHandle;
  const keys = currentState.images
    .filter((image) => {
      if (["complete", "filtered", "queued", "downloading"].includes(image.status)) return false;
      return includeSkippedForDirectoryRescan || image.status !== "skipped";
    })
    .map((image) => image.key);
  await download(keys, "没有可下载的新图片");
});
$("#download-selected").addEventListener("click", () => {
  const keys = currentState.images.filter((image) => image.selected && !["complete", "skipped", "filtered"].includes(image.status)).map((image) => image.key);
  void download(keys, "请先选择要下载的图片");
});
$("#pause-download").addEventListener("click", () => void togglePause());
$("#select-all").addEventListener("click", () => void selectAll(true));
$("#select-none").addEventListener("click", () => void selectAll(false));

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "DOWNLOAD_PAUSED") {
    downloadPaused = Boolean(message.paused);
    updatePauseButton();
    if (!downloadPaused) {
      while (resumeWaiters.length) resumeWaiters.shift()();
    }
    return;
  }
  if (message.type === "DIRECTORY_SELECTED") {
    currentSettings = message.settings || currentSettings;
    directoryCheckedKeys.clear();
    currentState.images.forEach((image) => {
      if (["complete", "skipped"].includes(image.status)) {
        image.status = "ready";
        image.selected = true;
      }
    });
    void loadDirectoryHandle().then((handle) => {
      directoryHandle = handle;
      void hasDirectoryPermission(handle).then((granted) => {
        directoryPermissionGranted = granted;
        return refreshExistingStatuses();
      }).then(() => {
        render();
        showToast(directoryPermissionGranted
          ? `目录已授权：${currentSettings.folder}`
          : "目录已选择，但仍需要授权");
      });
    });
    return;
  }
  if (message.type !== "STATE_UPDATED" || message.tabId !== currentTabId) return;
  currentState = message.state || currentState;
  [...liveProgress.keys()].forEach((key) => {
    const image = currentState.images.find((item) => item.key === key);
    if (!image || image.status !== "downloading") liveProgress.delete(key);
  });
  render();
  scheduleDirectoryScan();
});

window.setInterval(() => void pollChromeDownloadProgress(), 500);

(async () => {
  const tab = await getCurrentTab();
  currentTabId = tab?.id ?? null;
  if (currentTabId == null) return;
  const response = await send({ type: "GET_STATE", tabId: currentTabId });
  currentState = response.state || currentState;
  currentSettings = response.settings || currentSettings;
  const pauseResponse = await send({ type: "GET_DOWNLOAD_STATUS" });
  downloadPaused = Boolean(pauseResponse.paused);
  directoryHandle = await loadDirectoryHandle();
  if (!directoryHandle) currentSettings.directoryMode = false;
  directoryPermissionGranted = await hasDirectoryPermission(directoryHandle);
  directoryCheckedKeys.clear();
  await refreshExistingStatuses();
  render();
})();
