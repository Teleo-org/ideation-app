const DATABASE = 'ideation-workbench';
const STORE = 'attachments';
const urls = new Map();

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts');
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function operation(mode, callback) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = callback(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

export async function storeGuestAttachment(projectId, blob, metadata = {}) {
  const id = metadata.id || crypto.randomUUID();
  const record = {
    id,
    projectId,
    blob,
    name: metadata.name || blob.name || 'attachment.bin',
    mime: metadata.mime || blob.type || 'application/octet-stream',
    size: blob.size,
    createdAt: new Date().toISOString(),
  };
  await operation('readwrite', (store) => store.put(record, id));
  const url = URL.createObjectURL(blob);
  urls.set(id, url);
  return { id, storageName: id, name: record.name, mime: record.mime, size: record.size, url, guest: true };
}

export async function hydrateGuestAttachments(state) {
  for (const implementation of state.implementations || []) {
    for (const attachment of implementation.attachments || []) {
      if (!attachment.guest && !String(attachment.storageName || '').startsWith('guest-')) continue;
      const id = attachment.id || attachment.storageName;
      let url = urls.get(id);
      if (!url) {
        const record = await operation('readonly', (store) => store.get(id));
        if (record?.blob) {
          url = URL.createObjectURL(record.blob);
          urls.set(id, url);
        }
      }
      if (url) attachment.url = url;
    }
  }
}

export async function deleteGuestAttachment(id) {
  await operation('readwrite', (store) => store.delete(id));
  if (urls.has(id)) URL.revokeObjectURL(urls.get(id));
  urls.delete(id);
}

