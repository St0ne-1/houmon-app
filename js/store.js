"use strict";
/**
 * store.js ── 端末の中の保存領域(設計 §3、IP-12)。ブラウザ専用(indexedDB/localStorage/navigator)。
 * Node のテストからは実行できない(indexedDB が無いため)。app.js からのみ使う。
 *
 * 実現する設計項目/要件ID:
 *  - IP-12 / ADR-015、D1 #1:保存に失敗しても記録の操作を止めない。
 *    失敗した書き込みはメモリに残し、次の書き込みのときにもう一度試す(タスク指示の守ること9)。
 *  - 置き場(オブジェクトストア)3つ:candidates(key="current")/records(keyPath=visit_id、
 *    索引 by_corp)/state(name→値)。DB名は通常 houmon、架空データのモードは houmon_kakuu。
 *
 * 呼び出し側(app.js)へは常に { ok, error? } を返し、例外を投げない
 * (「保存できませんでした」等の文言は app.js 側の定数で出す)。
 */

export const DB_VERSION = 1;

export function dbNameForMode(mode) {
  return mode === "kakuu" ? "houmon_kakuu" : "houmon";
}

export function readMode() {
  try {
    return localStorage.getItem("houmon.mode") || "real";
  } catch {
    return "real";
  }
}

export function writeMode(mode) {
  try {
    localStorage.setItem("houmon.mode", mode);
    return true;
  } catch {
    return false;
  }
}

// 保存領域を開くのを待つ上限。成功も失敗も返ってこない環境がある(埋め込みのブラウザで確認。
// iOS でも過去に同じ不具合があった)。待ち続けると画面が「読み込み中…」のまま止まるので、
// 上限を過ぎたら「保存領域が使えません」として記録の操作を続ける(ADR-015・設計§7)。
const OPEN_TIMEOUT_MS = 4000;
// 開けなかった直後は、この間は開き直さずにすぐ失敗を返す(読み込みのたびに待たせないため)。
const RETRY_AFTER_MS = 30000;

function openDatabase(dbName) {
  return new Promise((resolve, reject) => {
    let request;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error("保存領域を開くのに時間がかかりすぎました"));
    }, OPEN_TIMEOUT_MS);
    try {
      request = indexedDB.open(dbName, DB_VERSION);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("candidates")) {
        db.createObjectStore("candidates");
      }
      if (!db.objectStoreNames.contains("records")) {
        const s = db.createObjectStore("records", { keyPath: "visit_id" });
        s.createIndex("by_corp", "hojin_bango", { unique: false });
      }
      if (!db.objectStoreNames.contains("state")) {
        db.createObjectStore("state");
      }
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      if (timedOut) {
        request.result.close(); // 上限を過ぎてから開いた分は使わない(次の ensureOpen で開き直す)
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error || new Error("open failed"));
    };
    request.onblocked = () => {
      clearTimeout(timer);
      reject(new Error("保存領域がほかの画面で使われています"));
    };
  });
}

export class Store {
  constructor(mode) {
    this.mode = mode;
    this.dbName = dbNameForMode(mode);
    this.db = null;
    this.unavailable = false; // DBがそもそも開けない(§7「保存領域が使えません」)
    this.pending = []; // 失敗した書き込み。次の書き込み時にもう一度試す(守ること9)
    this.opening = null; // 開いている途中の約束(同時に呼ばれても1回だけ開く)
    this.failedAt = 0; // 開けなかった時刻
  }

  async ensureOpen() {
    if (this.db) return this.db;
    if (this.failedAt && Date.now() - this.failedAt < RETRY_AFTER_MS) {
      throw new Error("保存領域が使えません");
    }
    if (!this.opening) {
      this.opening = openDatabase(this.dbName).finally(() => {
        this.opening = null;
      });
    }
    try {
      this.db = await this.opening;
      this.unavailable = false;
      this.failedAt = 0;
      if (navigator.storage && navigator.storage.persist) {
        try {
          await navigator.storage.persist();
        } catch {
          /* 消されにくさは best effort。失敗しても致命的ではない */
        }
      }
      return this.db;
    } catch (e) {
      this.unavailable = true;
      this.failedAt = Date.now();
      throw e;
    }
  }

  async _rawPut(storeName, key, value) {
    const db = await this.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      try {
        if (key === undefined) store.put(value);
        else store.put(value, key);
      } catch (e) {
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("write failed"));
      tx.onabort = () => reject(tx.error || new Error("aborted"));
    });
  }

  /** 前回失敗した書き込みをもう一度試す(成功した分だけキューから外す)。 */
  async flushPending() {
    if (this.pending.length === 0) return;
    const remaining = [];
    for (const item of this.pending) {
      try {
        await this._rawPut(item.storeName, item.key, item.value);
      } catch {
        remaining.push(item);
      }
    }
    this.pending = remaining;
  }

  /** 書き込み。失敗しても例外を投げず、キューに積んで { ok:false } を返す(IP-12)。 */
  async put(storeName, key, value) {
    await this.flushPending().catch(() => {});
    try {
      await this._rawPut(storeName, key, value);
      return { ok: true };
    } catch (e) {
      this.pending.push({ storeName, key, value });
      return { ok: false, error: e, unavailable: this.unavailable };
    }
  }

  async get(storeName, key) {
    try {
      const db = await this.ensureOpen();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    }
  }

  async getAll(storeName) {
    try {
      const db = await this.ensureOpen();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return [];
    }
  }

  async getByCorp(hojinBango) {
    try {
      const db = await this.ensureOpen();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("records", "readonly");
        const idx = tx.objectStore("records").index("by_corp");
        const req = idx.getAll(hojinBango);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return [];
    }
  }

  async delete(storeName, key) {
    try {
      const db = await this.ensureOpen();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve({ ok: true });
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  // ---- 意味のある名前を付けた薄いラッパー(呼び出し側を読みやすくするだけ) ----

  saveCandidates(value) {
    return this.put("candidates", "current", value);
  }

  loadCandidates() {
    return this.get("candidates", "current");
  }

  saveRecord(record) {
    return this.put("records", undefined, record); // keyPath=visit_id
  }

  allRecords() {
    return this.getAll("records");
  }

  recordsForCorp(hojinBango) {
    return this.getByCorp(hojinBango);
  }

  saveState(name, value) {
    return this.put("state", name, value);
  }

  loadState(name) {
    return this.get("state", name);
  }

  /**
   * 古い記録の整理(★設計§3)。「受け取り済みの印」以前で、かつ cutoffDateStr より前の
   * 記録だけを消す(Mac に届いていることが分かっているものだけ)。canceled は問わない。
   */
  async purgeOldReceivedRecords(receivedMark, cutoffDateStr) {
    if (!receivedMark) return { deleted: 0 };
    const all = await this.allRecords();
    let deleted = 0;
    for (const r of all) {
      const mtime = r.updated_at || r.recorded_at;
      const day = (r.visited_at || "").slice(0, 10);
      if (mtime && mtime <= receivedMark && day && day < cutoffDateStr) {
        const res = await this.delete("records", r.visit_id);
        if (res.ok) deleted += 1;
      }
    }
    return { deleted };
  }
}
