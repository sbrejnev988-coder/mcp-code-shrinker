// ═══ Context Cache — отслеживание файлов в сессии ═══
import { createHash } from "crypto";

export class ContextCache {
  constructor() {
    /** @type {Map<string, { code: string, fingerprint: import("./types.js").FileFingerprint, aliasMap: import("./types.js").AliasMap, mtime: number }>} */
    this.files = new Map();
    /** @type {Map<string, string>} hash → first 16 chars key */
    this.hashes = new Map();
    /** @type {Map<string, any>} prompt hash → cached response */
    this.responseCache = new Map();
    this.responseCacheMax = 500;
    this.sessionStart = Date.now();
  }

  hash(code) {
    const full = createHash("sha256").update(code).digest("hex");
    this.hashes.set(full.slice(0, 16), full);
    return full.slice(0, 16);
  }

  /** Запомнить файл в сессии */
  track(filePath, code, fingerprint, aliasMap) {
    const h = this.hash(code);
    this.files.set(filePath, {
      code,
      fingerprint: { ...fingerprint, hash: h },
      aliasMap,
      mtime: Date.now(),
    });
    return h;
  }

  /** Получить отслеживаемый файл */
  get(filePath) {
    return this.files.get(filePath);
  }

  /** Кешировать ответ LLM */
  cacheResponse(prompt, response) {
    const h = createHash("sha256").update(JSON.stringify(prompt)).digest("hex").slice(0, 20);
    if (this.responseCache.size >= this.responseCacheMax) {
      const first = this.responseCache.keys().next().value;
      this.responseCache.delete(first);
    }
    this.responseCache.set(h, { response, time: Date.now() });
    return h;
  }

  /** Получить кешированный ответ */
  getCachedResponse(prompt) {
    const h = createHash("sha256").update(JSON.stringify(prompt)).digest("hex").slice(0, 20);
    const entry = this.responseCache.get(h);
    if (entry && Date.now() - entry.time < 300000) { // 5 min TTL
      return entry.response;
    }
    return null;
  }

  /** Очистка старых файлов (>1h без обращений) */
  gc() {
    const now = Date.now();
    for (const [k, v] of this.files) {
      if (now - v.mtime > 3600000) this.files.delete(k);
    }
    // Очистка response cache
    for (const [k, v] of this.responseCache) {
      if (now - v.time > 300000) this.responseCache.delete(k);
    }
  }
}
