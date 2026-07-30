const DB_NAME = "yanlan";
const DB_VERSION = 1;
const RECORDINGS = "recordings";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RECORDINGS)) request.result.createObjectStore(RECORDINGS, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地录音数据库"));
  });
}

async function transact(mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(RECORDINGS, mode);
    const request = operation(transaction.objectStore(RECORDINGS));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("本地录音操作失败"));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error("本地录音操作失败"));
  });
}

export function saveRecording(id, blob, metadata = {}) {
  return transact("readwrite", (store) => store.put({ id, blob, ...metadata, savedAt: new Date().toISOString() }));
}

export function getRecording(id) {
  return transact("readonly", (store) => store.get(id));
}

export function deleteRecording(id) {
  return transact("readwrite", (store) => store.delete(id));
}
