const currentFolderElement = document.querySelector("#current-folder");
const statusElement = document.querySelector("#status");
const chooseButton = document.querySelector("#choose-folder");

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

const renderCurrentFolder = async () => {
  const handle = await loadDirectoryHandle();
  const response = await send({ type: "GET_STATE" });
  if (response.settings?.directoryMode && handle) {
    currentFolderElement.textContent = `已授权：${handle.name}`;
  } else {
    currentFolderElement.textContent = "未选择文件夹（将使用 Chrome 默认下载目录）";
  }
};

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
    await saveDirectoryHandle(handle);
    const response = await send({ type: "DIRECTORY_SELECTED", name: handle.name });
    if (response.error) throw new Error(response.error);
    currentFolderElement.textContent = `已授权：${handle.name}`;
    setStatus(`已保存下载目录：${handle.name}`);
  } catch (error) {
    if (error?.name === "AbortError") setStatus("已取消选择");
    else setStatus(error?.message || "打开文件夹选择器失败", true);
  } finally {
    chooseButton.disabled = false;
  }
});

void renderCurrentFolder();
