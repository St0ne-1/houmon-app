"use strict";
/**
 * sw.js ── 電波が無くても開けるようにする(設計§8「電波が無くても開ける」・IP-12)。
 * アプリのファイル一式を端末に置いておく。版が変わったら古いキャッシュを入れ替える。
 * CACHE の版は app.js の APP_VERSION と同じ値にする(単体テスト tests/version.test.js で確認)。
 */
const CACHE = "houmon-app-v0.1.0";
const FILES = [
  "./",
  "index.html",
  "style.css",
  "manifest.json",
  "icon.png",
  "sample_candidates.json",
  "js/app.js",
  "js/store.js",
  "js/files.js",
  "js/route.js",
  "js/timewin.js",
  "js/records.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  // candidates/records はネットワークに出ず IndexedDB にしか無いので、ここはアプリ本体の
  // ファイル(同一オリジン)だけを相手にする。キャッシュ優先、無ければ通常どおり取得。
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
