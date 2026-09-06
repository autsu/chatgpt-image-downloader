let currentTabId = null;
let currentState = { images: [] };
let currentSettings = { folder: "ChatGPT Images", directoryMode: false };
let directoryHandle = null;
let downloadPaused = false;
const activeDirectKeys = new Set();
const resumeWaiters = [];
let toastTimer = null;
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
    const current = await handle.queryPermission?.({ mode: "readwrite" });
    if (current === "granted") return true;
    return await handle.requestPermission({ mode: "readwrite" }) === "granted";
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

const getRemoteFileSize = async (url) => {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store"
    });
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get("content-length"));
    return Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null;
  } catch {
    return null;
  }
};

const existingFileMatchesSource = async (directory, image) => {
  let fileHandle;
  try {
    fileHandle = await directory.getFileHandle(image.filename, { create: false });
  } catch (error) {
    if (error?.name === "NotFoundError") return false;
    throw error;
  }

  const localFile = await fileHandle.getFile();
  const remoteSize = await getRemoteFileSize(image.url);
  // 没有 Content-Length 时，按同名文件跳过，避免为校验而重复下载整个文件。
  return remoteSize == null || localFile.size === remoteSize;
};

const statusText = (image) => {
  if (image.status === "skipped") return "已存在，跳过";
  if (image.status === "complete") return "下载完成";
  if (image.status === "downloading") return "下载中";
  if (image.status === "queued") return "排队中";
  if (image.status === "error") return image.error || "下载失败";
  return "待下载";
};

const render = () => {
  const images = currentState.images || [];
  const selected = images.filter((image) => image.selected && !["complete", "skipped"].includes(image.status));
  const active = images.filter((image) => ["queued", "downloading"].includes(image.status)).length;
  $("#scanned-count").textContent = images.length;
  $("#selected-count").textContent = selected.length;
  $("#folder-input").value = currentSettings.directoryMode && directoryHandle
    ? currentSettings.folder || directoryHandle.name
    : "未选择文件夹（Chrome 默认下载目录）";
  $("#folder-input").readOnly = true;
  $("#folder-mode-hint").textContent = currentSettings.directoryMode
    ? `已选择“${currentSettings.folder || "目标文件夹"}”，下载会直接保存到该文件夹。完整绝对路径由 Chrome 隐藏。`
    : "尚未选择目录，当前会使用 Chrome 默认下载目录。点击齿轮设置保存目录。";
  $("#connection-dot").classList.add("connected");
  updatePauseButton();
  $("#scan-meta").textContent = downloadPaused
    ? "下载已暂停"
    : active ? `${active} 张正在下载` : "仅扫描“我的图片”区域，向下滚动继续";
  $("#list-subtitle").textContent = selected.length === images.filter((image) => !["complete", "skipped"].includes(image.status)).length ? "全部选中" : `${selected.length} 张已选中`;

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
    checkbox.disabled = ["complete", "skipped"].includes(image.status);
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

const markDirectStatus = async (keys, status, error = "") => {
  const response = await send({
    type: "DIRECT_DOWNLOAD_STATUS",
    tabId: currentTabId,
    keys,
    status,
    error
  });
  if (response.state) {
    currentState = response.state;
    render();
  }
  return response;
};

const refreshExistingStatuses = async () => {
  if (!currentSettings.directoryMode || !directoryHandle || currentTabId == null) return;
  const missingKeys = [];
  for (const image of currentState.images) {
    if (!['complete', 'skipped'].includes(image.status)) continue;
    try {
      await directoryHandle.getFileHandle(image.filename, { create: false });
    } catch (error) {
      if (error?.name === "NotFoundError") missingKeys.push(image.key);
    }
  }
  if (!missingKeys.length) return;
  const response = await markDirectStatus(missingKeys, "ready");
  if (response?.state) currentState = response.state;
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
    showToast("文件夹权限已失效，请重新选择文件夹");
    return;
  }
  await markDirectStatus(uniqueKeys, "queued");
  let completed = 0;
  let skipped = 0;
  try {
    for (const key of uniqueKeys) {
      await waitForResume();
      const image = currentState.images.find((item) => item.key === key);
      if (!image) continue;
      const currentHandle = directoryHandle;
      if (!currentHandle) {
        showToast("请先选择保存文件夹");
        break;
      }
      try {
        if (await existingFileMatchesSource(currentHandle, image)) {
          skipped += 1;
          await markDirectStatus([key], "skipped");
          continue;
        }
        await markDirectStatus([key], "downloading");
        const response = await fetch(image.url, { credentials: "include" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
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
  showToast(`已保存 ${completed} 张，已存在跳过 ${skipped} 张`);
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

const selectAll = async (checked) => {
  const selections = {};
  currentState.images.forEach((image) => {
    if (!["complete", "skipped"].includes(image.status)) selections[image.key] = checked;
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
  const response = await send({ type: "OPEN_SETTINGS_PAGE" });
  if (!response.ok) showToast("打开设置页失败");
});
$("#download-all").addEventListener("click", async () => {
  await refreshExistingStatuses();
  const keys = currentState.images
    .filter((image) => !["complete", "queued", "downloading"].includes(image.status))
    .map((image) => image.key);
  await download(keys, "没有可下载的新图片");
});
$("#download-selected").addEventListener("click", () => {
  const keys = currentState.images.filter((image) => image.selected && !["complete", "skipped"].includes(image.status)).map((image) => image.key);
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
    currentState.images.forEach((image) => {
      if (["complete", "skipped"].includes(image.status)) {
        image.status = "ready";
        image.selected = true;
      }
    });
    void loadDirectoryHandle().then((handle) => {
      directoryHandle = handle;
      void refreshExistingStatuses().then(() => {
        render();
        showToast(`已选择文件夹：${currentSettings.folder}`);
      });
    });
    return;
  }
  if (message.type !== "STATE_UPDATED" || message.tabId !== currentTabId) return;
  currentState = message.state || currentState;
  render();
});

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
  await refreshExistingStatuses();
  render();
})();
