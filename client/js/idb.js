// IndexedDB 封装：随车端离线数据持久化
//  - outbox: 待同步/已同步/隔离/失败的事件记录（网络断了也不丢）
//  - cache:  调度端下发的状态缓存（断网时仍可查看转运单）
const IDB = {
  _db: null,

  async open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('coldchain', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('outbox')) {
          const s = db.createObjectStore('outbox', { keyPath: 'event_id' });
          s.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains('cache')) {
          db.createObjectStore('cache', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  },

  async _tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  },

  async outboxAdd(rec) {
    return this._tx('outbox', 'readwrite', (s) => s.put(rec));
  },
  async outboxAll() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('outbox').objectStore('outbox').getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async outboxUpdate(rec) {
    return this._tx('outbox', 'readwrite', (s) => s.put(rec));
  },
  async outboxDelete(id) {
    return this._tx('outbox', 'readwrite', (s) => s.delete(id));
  },
  async outboxClearDone() {
    // 清除已确认（synced/isolated/conflict）的记录，保留 pending/failed
    const all = await this.outboxAll();
    const done = all.filter((r) => ['synced', 'isolated', 'conflict'].includes(r.status));
    await Promise.all(done.map((r) => this.outboxDelete(r.event_id)));
  },

  async cacheSet(key, value) {
    return this._tx('cache', 'readwrite', (s) => s.put({ key, value, ts: Date.now() }));
  },
  async cacheGet(key) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction('cache').objectStore('cache').get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => reject(req.error);
    });
  },
};
