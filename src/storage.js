const DB_NAME = "yanlan";
const DB_VERSION = 2;
const RECORDINGS = "recordings";
const RECORDING_CHUNKS = "recordingChunks";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RECORDINGS)) request.result.createObjectStore(RECORDINGS, { keyPath: "id" });
      if (!request.result.objectStoreNames.contains(RECORDING_CHUNKS)) {
        const chunks = request.result.createObjectStore(RECORDING_CHUNKS, { keyPath: ["meetingId", "index"] });
        chunks.createIndex("meetingId", "meetingId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地录音数据库"));
  });
}

async function transact(storeNames, mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const transaction = database.transaction(names, mode);
    const stores = Object.fromEntries(names.map((name) => [name, transaction.objectStore(name)]));
    let result;
    let settled = false;
    try {
      const request = operation(stores, transaction);
      if (request) request.onsuccess = () => { result = request.result; };
    } catch (error) {
      settled = true;
      try { transaction.abort(); } catch {}
      database.close();
      reject(error);
      return;
    }
    transaction.oncomplete = () => {
      settled = true;
      database.close();
      resolve(result);
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      database.close();
      reject(transaction.error || new Error("本地录音操作失败"));
    };
    transaction.onerror = fail;
    transaction.onabort = fail;
  });
}

export function saveRecording(id, blob, metadata = {}) {
  return transact([RECORDINGS, RECORDING_CHUNKS], "readwrite", (stores) => {
    const request = stores[RECORDINGS].put({ id, blob, ...metadata, savedAt: new Date().toISOString() });
    deleteChunksFromStore(stores[RECORDING_CHUNKS], id);
    return request;
  });
}

export function getRecording(id) {
  return transact(RECORDINGS, "readonly", (stores) => stores[RECORDINGS].get(id));
}

export function saveRecordingChunk(meetingId, index, blob, metadata = {}) {
  return transact(RECORDING_CHUNKS, "readwrite", (stores) => stores[RECORDING_CHUNKS].put({
    meetingId,
    index,
    blob,
    ...metadata,
    savedAt: new Date().toISOString(),
  }));
}

export function getRecordingChunks(meetingId) {
  return transact(RECORDING_CHUNKS, "readonly", (stores) => (
    stores[RECORDING_CHUNKS].index("meetingId").getAll(IDBKeyRange.only(meetingId))
  )).then((chunks = []) => chunks.sort((left, right) => left.index - right.index));
}

export function deleteRecording(id) {
  return transact([RECORDINGS, RECORDING_CHUNKS], "readwrite", (stores) => {
    const request = stores[RECORDINGS].delete(id);
    deleteChunksFromStore(stores[RECORDING_CHUNKS], id);
    return request;
  });
}

function deleteChunksFromStore(store, meetingId) {
  const request = store.index("meetingId").openKeyCursor(IDBKeyRange.only(meetingId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    store.delete(cursor.primaryKey);
    cursor.continue();
  };
}
