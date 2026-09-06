const statusElement = document.querySelector("#status");
const button = document.querySelector("#pick");

const setStatus = (message, error = false) => {
  statusElement.textContent = message;
  statusElement.classList.toggle("error", error);
};

const requestWritePermission = async (handle) => {
  const current = await handle.queryPermission?.({ mode: "readwrite" });
  if (current === "granted") return true;
  return await handle.requestPermission({ mode: "readwrite" }) === "granted";
};

const openDatabase = () => new Promise((resolve, reject) => {
  const request = indexedDB.open("chatgpt-image-downloader", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("handles");
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const saveHandle = async (handle) => {
  const db = await openDatabase();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("handles", "readwrite");
    transaction.objectStore("handles").put(handle, "selected-directory");
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
};

button.addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    setStatus("当前 Chrome 不支持文件夹选择器，请升级 Chrome", true);
    return;
  }
  button.disabled = true;
  setStatus("等待选择文件夹…");
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", startIn: "downloads" });
    if (!(await requestWritePermission(handle))) throw new Error("没有获得写入权限");
    await saveHandle(handle);
    await chrome.runtime.sendMessage({ type: "DIRECTORY_SELECTED", name: handle.name });
    setStatus(`已选择：${handle.name}`);
  } catch (error) {
    if (error?.name === "AbortError") setStatus("已取消选择");
    else setStatus(error?.message || "打开文件夹选择器失败", true);
    button.disabled = false;
  }
});
