const currentFolderElement = document.querySelector("#current-folder");
const statusElement = document.querySelector("#status");
const chooseButton = document.querySelector("#choose-folder");
const authorizeButton = document.querySelector("#authorize-folder");
const query = new URLSearchParams(location.search);
const returnTabId = Number(query.get("returnTabId")) || null;
const requestedMode = query.get("mode") || "settings";
let currentHandle = null;

const send = (message) => new Promise((resolve) => {
  chrome.runtime.sendMessage(message, (response) => {
    void chrome.runtime.lastError;
    resolve(response || {});
  });
});

const setStatus = (message, error = false) => {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", error);
};

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
  const current = await handle.queryPermission?.({ mode: "readwrite" });
  if (current === "granted") return true;
  return await handle.requestPermission({ mode: "readwrite" }) === "granted";
};

const returnToImages = async () => {
  if (returnTabId == null) return;
  try {
    await chrome.tabs.update(returnTabId, { active: true });
    const currentTab = await chrome.tabs.getCurrent();
    if (currentTab?.id != null) await chrome.tabs.remove(currentTab.id);
  } catch {
    // The source Images tab may have been closed.
  }
};

const finishAuthorization = async (handle, message) => {
  await saveDirectoryHandle(handle);
  const response = await send({ type: "DIRECTORY_SELECTED", name: handle.name });
  if (response.error) throw new Error(response.error);
  currentHandle = handle;
  currentFolderElement.textContent = `已授权：${handle.name}`;
  authorizeButton.hidden = true;
  setStatus(message);
  window.setTimeout(() => void returnToImages(), 350);
};

const renderCurrentFolder = async () => {
  const handle = await loadDirectoryHandle();
  currentHandle = handle;
  const response = await send({ type: "GET_STATE" });
  if (response.settings?.directoryMode && handle) {
    const permission = await handle.queryPermission?.({ mode: "readwrite" });
    if (permission === "granted") {
      currentFolderElement.textContent = `已授权：${handle.name}`;
      authorizeButton.hidden = true;
      if (requestedMode === "reauthorize") {
        setStatus("目录权限仍然有效，正在返回…");
        window.setTimeout(() => void returnToImages(), 350);
      }
    } else {
      currentFolderElement.textContent = `需要重新授权：${handle.name}`;
      authorizeButton.hidden = false;
      setStatus("点击“授权当前文件夹并返回”，无需重新选择目录");
    }
  } else {
    currentFolderElement.textContent = "未选择文件夹（将使用 Chrome 默认下载目录）";
    authorizeButton.hidden = true;
  }
};

authorizeButton.addEventListener("click", async () => {
  if (!currentHandle) return;
  authorizeButton.disabled = true;
  chooseButton.disabled = true;
  setStatus("正在请求目录权限…");
  try {
    if (!(await hasDirectoryPermission(currentHandle))) throw new Error("没有获得该文件夹的写入权限");
    await finishAuthorization(currentHandle, `已重新授权：${currentHandle.name}，正在返回…`);
  } catch (error) {
    setStatus(error?.message || "重新授权失败", true);
    authorizeButton.disabled = false;
    chooseButton.disabled = false;
  }
});

chooseButton.addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    setStatus("当前 Chrome 不支持系统文件夹选择器，请升级 Chrome", true);
    return;
  }
  chooseButton.disabled = true;
  setStatus("等待选择文件夹…");
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", startIn: "downloads" });
    if (!(await hasDirectoryPermission(handle))) throw new Error("没有获得该文件夹的写入权限");
    await finishAuthorization(handle, `已选择：${handle.name}，正在返回…`);
  } catch (error) {
    if (error?.name === "AbortError") setStatus("已取消选择");
    else setStatus(error?.message || "打开文件夹选择器失败", true);
  } finally {
    chooseButton.disabled = false;
  }
});

void renderCurrentFolder();
