"use strict";
/**
 * app.js ── 画面と操作(設計 全般・IP-01〜IP-13)。ホーム画面 Web アプリの入口。
 *
 * DOM・ブラウザAPI(位置情報・共有・クリップボード・ファイル入力・サービスワーカー登録)を扱う。
 * IndexedDB/localStorage への実アクセスは store.js に閉じる。並べ方は route.js、時間帯は
 * timewin.js、ファイルの形は files.js、記録の作成・整形は records.js(すべてDOMに触れない)。
 *
 * 画面の文言・選択肢はすべてこのファイルの定数(MESSAGES・CHOICES 等)にまとめる。
 * CEOが文言を直したいときは、この定数だけを見ればよいようにする。
 */

import { buildRoute, initialOrder, nextLegMeters } from "./route.js";
import { splitByAvailability } from "./timewin.js";
import { parseIncomingFile, candidateFreshness } from "./files.js";
import {
  pad2,
  formatLocalDateTime,
  createRecord,
  changeResult,
  setPosition,
  setField,
  toggleSingleChoice,
  togglePresidentTime,
  isAtTextLimit,
  clampText,
  cancelRecord,
  isToday,
  countToday,
  countNotYetReceived,
  latestTodayRecordByCorp,
  buildExportPayload,
  mergeRestoredRecords,
} from "./records.js";
import { Store, readMode, writeMode } from "./store.js";

// app.js と sw.js の版は一致させる(単体テストで確かめる。設計§10)。
export const APP_VERSION = "0.1.1";

// ---- 動きに関わる既定値(★Claudeが決めた細部。数値はここだけ直せばよい) ----
const DEFAULT_DAILY_TARGET = 50; // REQ-012 の既定
const GEO_TIMEOUT_MS = 8000; // 設計§4-2・§5「8秒で諦める」
const MAP_OPEN_CHECK_MS = 1500; // 設計§7「地図アプリが開けないことの見分け方」
const UNDO_WINDOW_MS = 5000; // REQ-042「記録直後の数秒」
const SAVED_TEXT_MS = 2000; // D1 #3「保存しました」は1〜2秒で消す
const INFO_TOAST_MS = 3000; // 保存以外の通知(書き出し・復元等)の表示時間
const RESULT_DEBOUNCE_MS = 1000; // REQ-007 §1-9「連打」対策
const TIME_RECLASSIFY_MS = 60000; // 設計§4-1「1分ごとに区分1・2を計算し直す」
const OLD_RECORD_PURGE_DAYS = 7; // 設計§3「古い記録の整理」
const TEXT_FIELD_MAX = 500; // D1 #2 案A
const EXPORT_OVERDUE_MS = 12 * 60 * 60 * 1000; // 設計§4-1「12時間以上たっていて…目立たせる」

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
const WEEKDAY_JA_BY_CODE = { Sun: "日", Mon: "月", Tue: "火", Wed: "水", Thu: "木", Fri: "金", Sat: "土" };

// jageocoder README.md §3-(4)の文言そのまま(mac/houmon/geocode.py と同じ内容を書き写した。
// 候補ファイルが無いときの既定表示に使う=設計§4-3「アプリに組み込んだ同じ文言」)。
const DEFAULT_CITATIONS = [
  "「位置参照情報(大字町丁目・街区レベル)令和6年」(国土交通省)、" +
    "「電子国土基本図(地名情報)住居表示住所」(国土地理院)、" +
    "「Geolonia 住所データ」(株式会社Geolonia) https://geolonia.github.io/japanese-addresses/、" +
    "「アドレス・ベース・レジストリ」(デジタル庁) " +
    "https://www.digital.go.jp/policies/base_registry_address_tos/ " +
    "「登記所備付地図データ」(法務省) " +
    "をもとに、株式会社情報試作室が加工した " +
    "jageocoder 用住所データベース(住居表示レベル)を利用",
  "© OpenStreetMap contributors",
];

// ---- 画面の文言(設計§7ほか。CEOが直すときはここだけ見ればよい) ----
function formatMonthDay(dateStr) {
  if (!dateStr) return "";
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}月${d}日`;
}
function formatMonthDayWeekday(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return `${m}月${d}日(${WEEKDAY_JA[wd]})`;
}
function formatDateTimeMinuteJa(s) {
  if (!s || s.length < 16) return s || "";
  const [datePart, timePart] = s.split("T");
  return `${formatMonthDay(datePart)} ${timePart}`;
}

const MESSAGES = {
  headerCount: (dateStr, count) => `${formatMonthDayWeekday(dateStr)}の候補 ${count}社`,
  stale: (dateStr) => `候補を更新できていません(${formatMonthDay(dateStr)}の候補です)`,
  future: (dateStr) => `明日(${formatMonthDay(dateStr)})の候補です`,
  todayCount: (n, target) => `今日の記録 ${n}件(目標${target})`,
  notReceivedCount: (n) => `Mac に届いていない記録 ${n}件`,
  geoUnavailableNote: "位置情報が使えません(時刻だけ記録します)",
  noCandidatesEver: "候補のファイルがまだありません。Mac から届いたファイルを読んでください",
  zeroCandidates: "今日の候補はありません",
  badRowCount: (n) => `読み込めなかった候補が${n}件あります`,
  sectionImminent: "いま会えそう",
  sectionMain: "回る順",
  sectionPostponed: "後回し",
  sectionUnknown: "位置不明",
  sectionSkipped: "スキップ",
  sectionTodayDone: "今日記録した会社",
  restoreLabel: "戻す",
  roughPositionBadge: "位置が粗い",
  lastAbsentAgain: "前回不在",
  promisedDay: (dateStr) => `約束の日 ${formatMonthDay(dateStr)}`,
  nextLeg: (m) => `次まで ${m}m`,
  btnRebuild: "現在地から並べ直す",
  btnExport: "記録を書き出す",
  btnImport: "ファイルを読む",
  btnAbout: "このアプリについて",
  btnBack: "一覧に戻る",
  btnMapWalk: "地図で開く(徒歩)",
  btnMapBike: "地図で開く(自転車)",
  btnPostpone: "後回し",
  btnSkip: "スキップ",
  btnCopyAddress: "住所をコピー",
  addressCopied: "住所をコピーしました",
  addressCopyFailed: "コピーできませんでした",
  saved: "保存しました",
  undo: "取り消し",
  mapOpenFailed: "地図アプリを開けませんでした。住所をコピーできます",
  textLimit: "これ以上は入力できません",
  cancelConfirmTitle: "この記録を取り消しますか(取り消した記録は数えません)",
  cancelConfirmYes: "取り消す",
  cancelConfirmNo: "やめる",
  badFileFormat: "このファイルは想定した形式と違うようです。読み込みを中止しました",
  badFileVersion: "このファイルの版には対応していません",
  restoreDone: (n, dateStr) => `記録を戻しました(${n}件。${formatMonthDay(dateStr)}の分)`,
  restoreNone: "戻す記録がありませんでした",
  exportSharedDone: (n) => `書き出しました(${n}件)`,
  exportCanceled: "書き出しを取りやめました",
  exportSavedAsFile: "ファイルとして保存しました。「ファイル」アプリから AirDrop で Mac に送ってください",
  saveFailed: "保存できませんでした。空き容量を確認してください",
  storeUnavailable: "保存領域が使えません。記録はこの画面を閉じると消えます",
  rebuildNoGeo: "現在地が取れないため、並べ直しは一時的に使えません",
  brokenMatrixNotice: "道のりの表が読めなかったため、直線の距離で並べています",
  aboutTitle: "このアプリについて",
  fictionalBannerText: "架空データで試しています(実際の記録とは別に保存しています)",
  btnTryFictional: "架空の候補で試す",
  btnEndFictional: "架空データのモードを終える",
  candidateNotFound: "候補が見つかりません",
  todayRecordsTitle: "今日の記録",
};

// 追加項目の選択肢(ADR-010・020。★=選択肢そのものはClaudeが決めた細部)
const BRANCH_CHOICES = ["本社のみ", "支社1〜2", "支社3以上", "聞けなかった"];
const MET_WITH_CHOICES = ["社長", "社員", "事務"];
const PRESIDENT_TIME_CHOICES = ["朝(〜9時)", "午前(9〜12時)", "午後(12〜17時)", "夕方(17時〜)", "聞けなかった"];
const INDUSTRY_FIX_CHOICES = [
  "警備", "清掃", "設備点検・ビルメン",
  "建設/電気", "建設/管", "建設/造園", "建設/土木", "建設/建築", "建設/工種不明",
  "不動産(賃貸系)", "製造下請け", "小規模配送", "対象外(ほかの業種)",
];
const ROLE_CHOICES = ["元請け", "下請け", "両方"];
const DOC_VOLUME_CHOICES = ["多い(週に数本以上)", "ふつう(月に数本)", "少ない(ほとんど無い)", "聞けなかった"];
const EXTRA_RESULT_KINDS = new Set(["名刺のみ", "話せた", "再訪約束"]);
const QUICK_RESULT_KINDS = new Set(["不在", "門前払い"]);

// ---- アプリの状態(メモリ上。永続化は store.js を通す) ----
const state = {
  mode: "real",
  store: null,
  candidatesData: null, // files.js の value + loadedAt
  candidatesById: new Map(),
  recordsById: new Map(),
  routeState: emptyRouteState(),
  lastExport: null,
  screen: "list", // 'list' | 'record' | 'about'
  recordScreen: null, // { hojinBango, openedAtMs, activeVisitId, editingVisitId }
  confirmDialog: null, // { visitId } 取り消し(あとから)の確認
  rebuilding: false,
  skippedOpen: false,
  geoUnavailable: false, // boot() で navigator を見て設定し直す(トップレベルではブラウザAPIに触れない)
  resultLockUntil: 0,
  toast: { visitId: null },
  saveFailed: null, // null | "failed"(容量不足など) | "unavailable"(保存領域が開けない)
};

function emptyRouteState() {
  return { date: null, order: [], postponedOrder: [], postponedIds: [], skippedIds: [], rebuiltAt: null, usedStraightLineFallback: false };
}

function rebuildCandidatesIndex() {
  state.candidatesById = new Map(state.candidatesData ? state.candidatesData.candidates.map((c) => [c.hojin_bango, c]) : []);
}

function todayDateStr() {
  return formatLocalDateTime(new Date()).slice(0, 10);
}

function parseLocalDateTimeStr(s) {
  // "YYYY-MM-DDTHH:MM:SS" を確実にローカル時刻として組み立て直す。
  const [datePart, timePart] = String(s).split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm, ss] = (timePart || "00:00:00").split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, ss || 0);
}

function sevenDaysBeforeStr(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - OLD_RECORD_PURGE_DAYS);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 前回の結果の1行(再訪約束なら約束の日時を括弧で添える)。 */
function lastResultText(candidate) {
  if (!candidate.lastResult) return "";
  const when = candidate.revisitAt ? `(約束 ${formatDateTimeMinuteJa(candidate.revisitAt)})` : "";
  return `前回の結果: ${candidate.lastResult}${when}`;
}

function formatTimeHint(hint) {
  if (!hint || !Array.isArray(hint.windows) || hint.windows.length === 0) return "";
  const windowsText = hint.windows.map(([s, e]) => `${s}–${e}`).join("・");
  const avoid = Array.isArray(hint.avoid_weekdays) ? hint.avoid_weekdays : [];
  const avoidText = avoid.length ? `・${avoid.map((w) => WEEKDAY_JA_BY_CODE[w] || w).join("・")}曜は避ける` : "";
  return windowsText + avoidText;
}

function isExportOverdue() {
  if (!state.lastExport) return true;
  const last = parseLocalDateTimeStr(state.lastExport.at);
  return Date.now() - last.getTime() >= EXPORT_OVERDUE_MS;
}

// ============================================================ 起動 ====

async function boot() {
  state.geoUnavailable = !("geolocation" in navigator);
  state.mode = readMode();
  state.store = new Store(state.mode);
  registerServiceWorker();

  state.candidatesData = await state.store.loadCandidates();
  rebuildCandidatesIndex();
  const allRecords = await state.store.allRecords();
  state.recordsById = new Map(allRecords.map((r) => [r.visit_id, r]));
  state.routeState = (await state.store.loadState("route")) || emptyRouteState();
  state.lastExport = (await state.store.loadState("lastExport")) || null;

  wireEvents();
  render();
  setInterval(() => {
    if (state.screen === "list") render();
  }, TIME_RECLASSIFY_MS);
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* 電波なしで開く準備に失敗。致命的ではないので握りつぶす */
    });
  }
}

// ==================================================== モードの切り替え ====

/** 通常/架空データのモードを切り替え、保存領域を読み直す(IP-13)。 */
async function switchMode(newMode) {
  state.mode = newMode;
  writeMode(newMode);
  state.store = new Store(newMode);
  state.candidatesData = await state.store.loadCandidates();
  rebuildCandidatesIndex();
  const allRecords = await state.store.allRecords();
  state.recordsById = new Map(allRecords.map((r) => [r.visit_id, r]));
  state.routeState = (await state.store.loadState("route")) || emptyRouteState();
  state.lastExport = (await state.store.loadState("lastExport")) || null;
}

/** [架空の候補で試す]:同梱の sample_candidates.json を読む(同一オリジン。外部通信ではない)。 */
async function tryFictionalSample() {
  try {
    const res = await fetch("./sample_candidates.json");
    const text = await res.text();
    const parsed = parseIncomingFile(text);
    if (!parsed.ok || parsed.kind !== "candidates") return;
    // 試し用の候補は「読んだ日」を候補の日付として扱う(設計§9)。
    parsed.value.meta = { ...parsed.value.meta, date: todayDateStr() };
    parsed.value.isFictional = true;
    await applyCandidatesFile(parsed.value);
  } catch {
    /* 同梱ファイルなので通常起きない。起きても記録操作は止めない */
  }
}

async function endFictionalMode() {
  await switchMode("real");
  state.screen = "list";
  render();
}

// ==================================================== ファイルの読み込み ====

/** <input type=file> で選んだファイルを読む(IP-01・IP-10・IP-13)。 */
async function handleFileChosen(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    showToast(MESSAGES.badFileFormat);
    return;
  }
  const result = parseIncomingFile(text);
  if (!result.ok) {
    showToast(result.error === "unsupported_version" ? MESSAGES.badFileVersion : MESSAGES.badFileFormat);
    return;
  }
  if (result.kind === "candidates") {
    await applyCandidatesFile(result.value);
  } else if (result.kind === "restore") {
    await applyRestoreFile(result.value);
  }
}

/** 候補のファイルを取り込む(IP-01)。並びはファイルの順、後回し・スキップは空にする(設計§5)。 */
async function applyCandidatesFile(value) {
  const now = new Date();
  const newMode = value.isFictional ? "kakuu" : "real";
  if (newMode !== state.mode) await switchMode(newMode);

  state.candidatesData = { ...value, loadedAt: formatLocalDateTime(now) };
  rebuildCandidatesIndex();
  await state.store.saveCandidates(state.candidatesData);

  state.routeState = {
    date: value.meta.date,
    order: initialOrder(value.candidates),
    postponedOrder: [],
    postponedIds: [],
    skippedIds: [],
    rebuiltAt: null,
    usedStraightLineFallback: false,
  };
  await state.store.saveState("route", state.routeState);

  // 古い記録の整理(★設計§3)。受け取り済みの印が無ければ何もしない。
  if (value.meta.receivedMark) {
    await state.store.purgeOldReceivedRecords(value.meta.receivedMark, sevenDaysBeforeStr(now));
    const allRecords = await state.store.allRecords();
    state.recordsById = new Map(allRecords.map((r) => [r.visit_id, r]));
  }

  state.screen = "list";
  render();
}

/** 復元のファイルを取り込む(IP-10)。visit_idごとに新しい方を残す。 */
async function applyRestoreFile(value) {
  if (value.records.length === 0) {
    showToast(MESSAGES.restoreNone);
    return;
  }
  const { merged } = mergeRestoredRecords(state.recordsById, value.records);
  state.recordsById = merged;
  for (const r of merged.values()) {
    await state.store.saveRecord(r);
  }
  showToast(MESSAGES.restoreDone(value.records.length, value.meta.targetDate));
  render();
}

// ==================================================== 書き出し(IP-09) ====

async function handleExport() {
  const now = new Date();
  const records = Array.from(state.recordsById.values());
  const receivedMark = state.candidatesData?.meta?.receivedMark ?? null;
  const candidateDate = state.candidatesData?.meta?.date ?? null;
  const { payload, fileName, count } = buildExportPayload({
    records,
    receivedMark,
    todayStr: todayDateStr(),
    candidateDate,
    isFictional: state.mode === "kakuu",
    nowDate: now,
  });
  const text = JSON.stringify(payload, null, 1);

  // 共有シートで送れたら終わり。取りやめたら何もしない(最後に書き出した日時も変えない)。
  // 共有シートが使えない・取りやめ以外で失敗したときは、ファイルとして保存する(ADR-024 の緩和)。
  let outcome = "fallback";
  if (typeof File !== "undefined" && navigator.canShare) {
    const file = new File([text], fileName, { type: "application/json" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: fileName });
        outcome = "shared";
      } catch (e) {
        outcome = e && e.name === "AbortError" ? "canceled" : "fallback";
      }
    }
  }
  if (outcome === "canceled") {
    showToast(MESSAGES.exportCanceled);
    return;
  }
  if (outcome === "shared") {
    showToast(MESSAGES.exportSharedDone(count));
  } else {
    downloadAsFile(text, fileName);
    showToast(MESSAGES.exportSavedAsFile);
  }

  state.lastExport = { at: formatLocalDateTime(now), count };
  await state.store.saveState("lastExport", state.lastExport);
  render();
}

function downloadAsFile(text, fileName) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ==================================================== 位置情報 ====

function getCurrentPositionSafe(timeoutMs) {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve(null);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ lat: p.coords.latitude, lon: p.coords.longitude });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: timeoutMs }
    );
  });
}

// ==================================================== 並べ直し(IP-03) ====

async function handleRebuild() {
  if (state.rebuilding || !state.candidatesData) return;
  state.rebuilding = true;
  render();
  const pos = await getCurrentPositionSafe(GEO_TIMEOUT_MS);
  state.rebuilding = false;
  if (!pos) {
    state.geoUnavailable = true;
    showToast(MESSAGES.rebuildNoGeo);
    render();
    return;
  }
  state.geoUnavailable = false;
  const recordedToday = latestTodayRecordByCorp(Array.from(state.recordsById.values()), todayDateStr());
  const result = buildRoute({
    candidates: state.candidatesData.candidates,
    matrixDimension: state.candidatesData.matrixDimension,
    matrix: state.candidatesData.matrix,
    currentPosition: pos,
    recordedIds: Array.from(recordedToday.keys()),
    postponedIds: state.routeState.postponedIds,
    skippedIds: state.routeState.skippedIds,
  });
  state.routeState.order = result.mainOrder;
  state.routeState.postponedOrder = result.postponedOrder;
  state.routeState.rebuiltAt = formatLocalDateTime(new Date());
  state.routeState.usedStraightLineFallback = result.usedStraightLineFallback;
  await persistRouteState();
  if (result.usedStraightLineFallback) showToast(MESSAGES.brokenMatrixNotice);
  render();
}

function removeFromOrder(hojinBango) {
  state.routeState.order = state.routeState.order.filter((id) => id !== hojinBango);
}

function postponeCandidate(hojinBango) {
  removeFromOrder(hojinBango);
  // スキップ済みだった場合はそちらから外す(後回し・スキップは同時に属さない。設計§4-1)。
  state.routeState.skippedIds = state.routeState.skippedIds.filter((id) => id !== hojinBango);
  if (!state.routeState.postponedIds.includes(hojinBango)) state.routeState.postponedIds.push(hojinBango);
  if (!state.routeState.postponedOrder.includes(hojinBango)) state.routeState.postponedOrder.push(hojinBango);
  persistRouteState();
  goToList();
}

function skipCandidate(hojinBango) {
  removeFromOrder(hojinBango);
  state.routeState.postponedIds = state.routeState.postponedIds.filter((id) => id !== hojinBango);
  state.routeState.postponedOrder = state.routeState.postponedOrder.filter((id) => id !== hojinBango);
  if (!state.routeState.skippedIds.includes(hojinBango)) state.routeState.skippedIds.push(hojinBango);
  persistRouteState();
  goToList();
}

function restoreFromSkipped(hojinBango) {
  state.routeState.skippedIds = state.routeState.skippedIds.filter((id) => id !== hojinBango);
  if (!state.routeState.order.includes(hojinBango)) state.routeState.order.push(hojinBango);
  persistRouteState();
  render();
}

async function persistRouteState() {
  await state.store.saveState("route", state.routeState);
}

// ==================================================== 記録(IP-05〜IP-08) ====

async function persistRecord(record) {
  const res = await state.store.saveRecord(record);
  // 失敗は知らせの帯(消えない)で出す。直後の [取り消し] の知らせを上書きしないため(REQ-042・D1 #1)。
  const failed = res.ok ? null : res.unavailable ? "unavailable" : "failed";
  if (failed !== state.saveFailed) {
    state.saveFailed = failed;
    if (state.screen !== "about") render();
  }
  return res;
}

/** 保存の失敗・保存領域が使えないことを知らせる帯(一覧と記録の画面の上に出す)。 */
function storeNoteHtml() {
  if ((state.store && state.store.unavailable) || state.saveFailed === "unavailable") {
    return `<div class="banner warn">${MESSAGES.storeUnavailable}</div>`;
  }
  if (state.saveFailed === "failed") return `<div class="banner warn">${MESSAGES.saveFailed}</div>`;
  return "";
}

function openRecordScreen(hojinBango) {
  state.screen = "record";
  state.recordScreen = { hojinBango, openedAtMs: Date.now(), activeVisitId: null, editingVisitId: null };
  state.confirmDialog = null;
  render();
}

function openEditRecord(visitId) {
  const record = state.recordsById.get(visitId);
  if (!record || !state.recordScreen) return;
  state.recordScreen.activeVisitId = visitId;
  state.recordScreen.editingVisitId = visitId;
  render();
}

function goToList() {
  state.screen = "list";
  state.recordScreen = null;
  state.confirmDialog = null;
  render();
}

/** 結果ボタンを押したとき(IP-05・REQ-036・042)。2タップ・保存を待たずに一覧へ戻る。 */
function handleResultTap(result) {
  const now = new Date();
  if (now.getTime() < state.resultLockUntil) return; // 連打防止(1秒。REQ-007 §1-9)
  state.resultLockUntil = now.getTime() + RESULT_DEBOUNCE_MS;

  const rs = state.recordScreen;
  if (!rs) return;
  let record;
  let isNewRecord = false;
  if (rs.activeVisitId && state.recordsById.has(rs.activeVisitId)) {
    // 同じ画面のうちに別の結果を押した、または「今日の記録」からの修正→新しい記録を作らず
    // 結果だけ変える(設計§4-2★・IP-08)。位置は元のまま(修正のたびに現在地で上書きしない)。
    record = changeResult(state.recordsById.get(rs.activeVisitId), result, now);
  } else {
    const visitId = crypto.randomUUID();
    record = createRecord({ visitId, hojinBango: rs.hojinBango, result, openedAtMs: rs.openedAtMs, nowDate: now });
    rs.activeVisitId = visitId;
    isNewRecord = true;
  }
  state.recordsById.set(record.visit_id, record);
  persistRecord(record); // 待たない(設計§4-2)
  if (isNewRecord) fetchPositionAndAttach(record.visit_id); // 新規のときだけあとから位置を書き足す(ADR-015の4)

  showSavedToastWithUndo(record.visit_id);

  if (QUICK_RESULT_KINDS.has(result)) {
    goToList(); // 不在・門前払いは確認なしですぐ一覧へ(2タップの受入基準)
  } else {
    render(); // 名刺のみ・話せた・再訪約束は追加項目を表示
  }
}

async function fetchPositionAndAttach(visitId) {
  const pos = await getCurrentPositionSafe(GEO_TIMEOUT_MS);
  if (!pos) {
    state.geoUnavailable = true;
    if (state.screen === "list") render();
    return;
  }
  state.geoUnavailable = false;
  const record = state.recordsById.get(visitId);
  if (!record || record.canceled) return;
  const updated = setPosition(record, pos.lat, pos.lon);
  state.recordsById.set(visitId, updated);
  await persistRecord(updated);
  if (state.screen === "record" && state.recordScreen && state.recordScreen.activeVisitId === visitId) render();
}

/** 直後のワンタップ取り消し(確認なし。REQ-042)。 */
function handleImmediateUndo(visitId) {
  if (!visitId) return;
  const record = state.recordsById.get(visitId);
  if (!record) return;
  const canceled = cancelRecord(record, new Date());
  state.recordsById.set(visitId, canceled);
  persistRecord(canceled);
  hideToast();
  if (state.recordScreen && state.recordScreen.activeVisitId === visitId) {
    state.recordScreen.activeVisitId = null; // また新規に記録できる状態に戻す
  }
  render();
}

/** あとからの取り消し(確認あり。設計§7)。 */
function requestCancelConfirm(visitId) {
  state.confirmDialog = { visitId };
  render();
}
function confirmCancelRecord() {
  const visitId = state.confirmDialog && state.confirmDialog.visitId;
  state.confirmDialog = null;
  const record = visitId && state.recordsById.get(visitId);
  if (record) {
    const updated = cancelRecord(record, new Date());
    state.recordsById.set(visitId, updated);
    persistRecord(updated);
  }
  render();
}
function cancelConfirmDialog() {
  state.confirmDialog = null;
  render();
}

// ---- 追加項目(IP-06) ----

const pendingPersistTimers = new Map();
function schedulePersist(visitId) {
  clearTimeout(pendingPersistTimers.get(visitId));
  pendingPersistTimers.set(
    visitId,
    setTimeout(() => {
      const record = state.recordsById.get(visitId);
      if (record) persistRecord(record);
    }, 400)
  );
}

function handleFieldChoice(field, choice) {
  const rs = state.recordScreen;
  const record = rs && state.recordsById.get(rs.activeVisitId);
  if (!record) return;
  const now = new Date();
  const newValue = field === "president_time" ? togglePresidentTime(record[field], choice) : toggleSingleChoice(record[field], choice);
  const updated = setField(record, field, newValue, now);
  state.recordsById.set(record.visit_id, updated);
  persistRecord(updated);
  render();
}

function handleRevisitChange(value) {
  const rs = state.recordScreen;
  const record = rs && state.recordsById.get(rs.activeVisitId);
  if (!record) return;
  const minuteValue = value ? value.slice(0, 16) : null;
  const updated = setField(record, "revisit_at", minuteValue, new Date());
  state.recordsById.set(record.visit_id, updated);
  persistRecord(updated);
  render();
}

/** メモ・URL の入力(打鍵のたびに全画面再描画はしない=カーソル位置を失わないため)。 */
function handleTextFieldInput(field, inputEl) {
  const clamped = clampText(inputEl.value, TEXT_FIELD_MAX);
  if (clamped !== inputEl.value) inputEl.value = clamped;
  const rs = state.recordScreen;
  const record = rs && state.recordsById.get(rs.activeVisitId);
  if (!record) return;
  const updated = setField(record, field, clamped, new Date());
  state.recordsById.set(record.visit_id, updated);
  schedulePersist(record.visit_id);
  const note = inputEl.parentElement && inputEl.parentElement.querySelector(".small-note");
  if (note) note.hidden = !isAtTextLimit(clamped, TEXT_FIELD_MAX);
}

// ==================================================== 地図・住所コピー(IP-04) ====

function mapUrl(candidate, mode) {
  return `https://maps.apple.com/directions?destination=${candidate.lat},${candidate.lon}&mode=${mode}`;
}

function scheduleMapOpenCheck() {
  setTimeout(() => {
    if (document.visibilityState === "visible") showToast(MESSAGES.mapOpenFailed);
  }, MAP_OPEN_CHECK_MS);
}

async function copyAddress(candidate) {
  if (!candidate) return;
  try {
    await navigator.clipboard.writeText(candidate.address || "");
    showToast(MESSAGES.addressCopied);
  } catch {
    showToast(MESSAGES.addressCopyFailed);
  }
}

// ==================================================== 通知(トースト) ====

let toastHideTimer = null;
function showToast(text, opts = {}) {
  const toastEl = document.getElementById("toast");
  if (!toastEl) return;
  clearTimeout(toastHideTimer);
  const withUndo = !!opts.withUndo;
  toastEl.innerHTML =
    `<span>${escapeHtml(text)}</span>` + (withUndo ? `<button type="button" class="btn small" data-action="toast-undo">${MESSAGES.undo}</button>` : "");
  toastEl.hidden = false;
  state.toast = { visitId: opts.visitId || null };
  const duration = opts.durationMs || INFO_TOAST_MS;
  toastHideTimer = setTimeout(() => {
    toastEl.hidden = true;
    toastEl.innerHTML = "";
  }, duration);
}
function hideToast() {
  const toastEl = document.getElementById("toast");
  if (toastEl) {
    toastEl.hidden = true;
    toastEl.innerHTML = "";
  }
  clearTimeout(toastHideTimer);
}
let savedTextHideTimer = null;
function showSavedToastWithUndo(visitId) {
  // 「保存しました」は2秒で消し(D1 #3)、[取り消し] だけ5秒まで残す(REQ-042「記録直後の数秒」)。
  showToast(MESSAGES.saved, { withUndo: true, visitId, durationMs: UNDO_WINDOW_MS });
  clearTimeout(savedTextHideTimer);
  savedTextHideTimer = setTimeout(() => {
    const textEl = document.querySelector("#toast > span");
    if (textEl && state.toast.visitId === visitId) textEl.hidden = true;
  }, SAVED_TEXT_MS);
}

// ==================================================== 描画 ====

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  if (state.screen === "about") {
    renderAboutScreenAsync();
    return;
  }
  app.innerHTML = state.screen === "record" ? renderRecordScreen() : renderListScreen();
}

/** 架空データのモードの帯(どの画面でもいちばん上に出す。設計§9)。 */
function fictionalBannerHtml() {
  return state.mode === "kakuu" ? `<div class="banner fictional">${MESSAGES.fictionalBannerText}</div>` : "";
}

function topBarHtml() {
  return `
    <div class="topbar">
      <button type="button" class="btn" data-action="rebuild" ${state.rebuilding ? "disabled" : ""}>${MESSAGES.btnRebuild}</button>
      <button type="button" class="btn" data-action="export">${MESSAGES.btnExport}</button>
      <label class="btn" for="file-input">${MESSAGES.btnImport}</label>
      <button type="button" class="btn" data-action="about">${MESSAGES.btnAbout}</button>
    </div>`;
}

function candidateRowHtml(candidate, legMeters) {
  const badges = [];
  if (candidate.roughPosition) badges.push(MESSAGES.roughPositionBadge);
  if (candidate.reason === "再訪" && candidate.revisitAt) badges.push(MESSAGES.promisedDay(candidate.revisitAt.slice(0, 10)));
  if (candidate.reason === "不在再訪") badges.push(MESSAGES.lastAbsentAgain);

  const lastResultLine = escapeHtml(lastResultText(candidate));
  const timeHintText = formatTimeHint(candidate.timeHint);
  const legText = typeof legMeters === "number" ? MESSAGES.nextLeg(legMeters) : "";

  return `
    <li class="row" data-action="open-record" data-hojin="${escapeHtml(candidate.hojin_bango)}">
      <div class="row-main">
        <span class="row-name">${escapeHtml(candidate.name)}</span>
        <span class="row-industry">${escapeHtml(candidate.industry || "")}</span>
      </div>
      ${badges.length ? `<div class="row-badges">${badges.map((b) => `<span class="badge">${escapeHtml(b)}</span>`).join("")}</div>` : ""}
      ${lastResultLine ? `<div class="row-sub">${lastResultLine}</div>` : ""}
      ${timeHintText ? `<div class="row-sub">${escapeHtml(timeHintText)}</div>` : ""}
      ${legText ? `<div class="row-leg">${escapeHtml(legText)}</div>` : ""}
    </li>`;
}

function todayRecordRowHtml(record, candidate) {
  const name = candidate ? candidate.name : record.hojin_bango;
  const timeLabel = (record.recorded_at || "").slice(11, 16);
  return `
    <li class="row" data-result="${escapeHtml(record.result)}" data-action="open-record" data-hojin="${escapeHtml(record.hojin_bango)}">
      <div class="row-main"><span class="row-name">${escapeHtml(name)}</span><span class="row-result">${escapeHtml(record.result)}</span></div>
      <div class="row-sub">${escapeHtml(timeLabel)}</div>
    </li>`;
}

function sectionHtml(title, rowsHtml) {
  return `<section class="section"><h2 class="section-title">${escapeHtml(title)}</h2><ul class="row-list">${rowsHtml}</ul></section>`;
}

function legBetween(orderedList, candidate) {
  if (!state.candidatesData) return null;
  const idx = orderedList.indexOf(candidate);
  if (idx < 0 || idx === orderedList.length - 1) return null;
  return nextLegMeters(state.candidatesData.matrix, state.candidatesData.matrixDimension, candidate, orderedList[idx + 1]);
}

function buildSectionsHtml(recordedTodayMap) {
  const rs = state.routeState;
  const byId = state.candidatesById;
  // 今日すでに記録した会社は「今日記録した会社」区分だけに出す(ほかの区分からは除く)。
  const notRecordedToday = (c) => !recordedTodayMap.has(c.hojin_bango);
  const mainCandidates = rs.order.map((id) => byId.get(id)).filter(Boolean).filter(notRecordedToday);
  const { imminent, rest } = splitByAvailability(mainCandidates, new Date());
  const postponedCandidates = rs.postponedOrder.map((id) => byId.get(id)).filter(Boolean).filter(notRecordedToday);
  const unknownCandidates = Array.from(byId.values()).filter(
    (c) =>
      !c.hasPosition &&
      notRecordedToday(c) &&
      !rs.postponedIds.includes(c.hojin_bango) &&
      !rs.skippedIds.includes(c.hojin_bango)
  );
  const skippedCandidates = Array.from(byId.values()).filter((c) => rs.skippedIds.includes(c.hojin_bango) && notRecordedToday(c));

  // 「次まで◯m」は、同じ区分の中で1つ下の行までの道のり(画面で上から読む順に合わせる)。
  let html = "";
  if (imminent.length > 0) {
    html += sectionHtml(MESSAGES.sectionImminent, imminent.map((c) => candidateRowHtml(c, legBetween(imminent, c))).join(""));
  }
  html += sectionHtml(MESSAGES.sectionMain, rest.map((c) => candidateRowHtml(c, legBetween(rest, c))).join(""));
  if (postponedCandidates.length) {
    html += sectionHtml(MESSAGES.sectionPostponed, postponedCandidates.map((c) => candidateRowHtml(c, legBetween(postponedCandidates, c))).join(""));
  }
  if (unknownCandidates.length) {
    html += sectionHtml(MESSAGES.sectionUnknown, unknownCandidates.map((c) => candidateRowHtml(c, null)).join(""));
  }
  if (skippedCandidates.length) {
    const openClass = state.skippedOpen ? "" : " collapsed";
    html += `<section class="section">
      <button type="button" class="section-title toggle" data-action="toggle-skipped">${escapeHtml(MESSAGES.sectionSkipped)}(${skippedCandidates.length})</button>
      <ul class="row-list${openClass}">
        ${skippedCandidates
          .map(
            (c) => `
          <li class="row">
            <button type="button" class="row-main as-button" data-action="open-record" data-hojin="${escapeHtml(c.hojin_bango)}">${escapeHtml(c.name)}</button>
            <button type="button" class="btn small" data-action="restore-skipped" data-hojin="${escapeHtml(c.hojin_bango)}">${MESSAGES.restoreLabel}</button>
          </li>`
          )
          .join("")}
      </ul>
    </section>`;
  }
  const todayRows = Array.from(recordedTodayMap.values()).sort((a, b) => (b.recorded_at || "").localeCompare(a.recorded_at || ""));
  if (todayRows.length) {
    html += sectionHtml(MESSAGES.sectionTodayDone, todayRows.map((r) => todayRecordRowHtml(r, state.candidatesById.get(r.hojin_bango))).join(""));
  }
  return html;
}

function renderListScreen() {
  const todayStr = todayDateStr();
  const recordsArr = Array.from(state.recordsById.values());
  const recordedTodayMap = latestTodayRecordByCorp(recordsArr, todayStr);

  let bannerHtml = "";
  let countLineHtml = "";
  let emptyStateHtml = "";

  if (!state.candidatesData) {
    emptyStateHtml = `<div class="empty-state"><p>${MESSAGES.noCandidatesEver}</p><label class="btn" for="file-input">${MESSAGES.btnImport}</label></div>`;
  } else {
    const meta = state.candidatesData.meta;
    const freshness = candidateFreshness(meta.date, todayStr);
    if (freshness === "past") bannerHtml = `<div class="banner warn">${escapeHtml(MESSAGES.stale(meta.date))}</div>`;
    else if (freshness === "future") bannerHtml = `<div class="banner">${escapeHtml(MESSAGES.future(meta.date))}</div>`;

    countLineHtml =
      state.candidatesData.candidates.length === 0
        ? `<p class="count-line">${MESSAGES.zeroCandidates}</p>`
        : `<p class="count-line">${escapeHtml(MESSAGES.headerCount(meta.date, state.candidatesData.candidates.length))}</p>`;
  }

  const todayCountHtml = `<p class="today-count">${escapeHtml(MESSAGES.todayCount(countToday(recordsArr, todayStr), DEFAULT_DAILY_TARGET))}</p>`;

  const receivedMark = state.candidatesData?.meta?.receivedMark ?? null;
  const notReceivedN = countNotYetReceived(recordsArr, receivedMark);
  const notReceivedHtml =
    notReceivedN > 0
      ? `<p class="not-received${isExportOverdue() ? " warn" : ""}">${escapeHtml(MESSAGES.notReceivedCount(notReceivedN))}</p>`
      : "";

  const geoNoteHtml = state.geoUnavailable ? `<p class="small-note">${MESSAGES.geoUnavailableNote}</p>` : "";
  const badRowHtml =
    state.candidatesData && state.candidatesData.badRowCount > 0
      ? `<p class="small-note">${escapeHtml(MESSAGES.badRowCount(state.candidatesData.badRowCount))}</p>`
      : "";
  const sectionsHtml =
    state.candidatesData && state.candidatesData.candidates.length > 0 ? buildSectionsHtml(recordedTodayMap) : "";

  return `
    ${fictionalBannerHtml()}
    ${storeNoteHtml()}
    ${topBarHtml()}
    ${bannerHtml}
    ${countLineHtml}
    ${todayCountHtml}
    ${notReceivedHtml}
    ${geoNoteHtml}
    ${badRowHtml}
    ${emptyStateHtml}
    ${sectionsHtml}
  `;
}

function choiceGroupHtml(fieldName, choices, currentValue, isSingle) {
  const selected = new Set(isSingle ? (currentValue ? [currentValue] : []) : currentValue ? String(currentValue).split("・") : []);
  return `<div class="choice-group">
    ${choices
      .map(
        (c) =>
          `<button type="button" class="choice-btn${selected.has(c) ? " selected" : ""}" data-action="field-choice" data-field="${fieldName}" data-choice="${escapeHtml(
            c
          )}">${escapeHtml(c)}</button>`
      )
      .join("")}
  </div>`;
}

function extraFieldsHtml(record) {
  const revisitHtml =
    record.result === "再訪約束"
      ? `<label class="field-label">再訪約束の日時
          <input type="datetime-local" data-action="field-revisit" value="${escapeHtml(record.revisit_at || "")}">
        </label>`
      : "";
  return `
    <div class="extra-fields">
      <div class="field-group"><p class="field-label">他拠点</p>${choiceGroupHtml("branches", BRANCH_CHOICES, record.branches, true)}</div>
      <div class="field-group"><p class="field-label">会えた相手</p>${choiceGroupHtml("met_with", MET_WITH_CHOICES, record.met_with, true)}</div>
      <div class="field-group"><p class="field-label">社長のいる時間帯(複数可)</p>${choiceGroupHtml(
        "president_time",
        PRESIDENT_TIME_CHOICES,
        record.president_time,
        false
      )}</div>
      <div class="field-group"><p class="field-label">業種の訂正</p>${choiceGroupHtml("industry_fix", INDUSTRY_FIX_CHOICES, record.industry_fix, true)}</div>
      <div class="field-group"><p class="field-label">元請け・下請け</p>${choiceGroupHtml("role", ROLE_CHOICES, record.role, true)}</div>
      <div class="field-group"><p class="field-label">書類業務の量</p>${choiceGroupHtml("doc_volume", DOC_VOLUME_CHOICES, record.doc_volume, true)}</div>
      ${revisitHtml}
      <label class="field-label">社長の反応・メモ
        <textarea data-action="field-reaction" maxlength="${TEXT_FIELD_MAX}" rows="3">${escapeHtml(record.reaction || "")}</textarea>
        <span class="small-note" ${isAtTextLimit(record.reaction || "", TEXT_FIELD_MAX) ? "" : "hidden"}>${MESSAGES.textLimit}</span>
      </label>
      <label class="field-label">URL
        <input type="url" inputmode="url" data-action="field-url" maxlength="${TEXT_FIELD_MAX}" value="${escapeHtml(record.url || "")}">
        <span class="small-note" ${isAtTextLimit(record.url || "", TEXT_FIELD_MAX) ? "" : "hidden"}>${MESSAGES.textLimit}</span>
      </label>
    </div>`;
}

function todayRecordsMiniListHtml(records, rs) {
  return `<div class="today-mini">
    <p class="section-title">${MESSAGES.todayRecordsTitle}</p>
    <ul class="row-list">
      ${records
        .map(
          (r) => `
        <li class="row${rs.editingVisitId === r.visit_id ? " editing" : ""}">
          <button type="button" class="row-main as-button" data-action="edit-record" data-visit="${escapeHtml(r.visit_id)}">
            <span>${escapeHtml(r.result)}</span><span>${escapeHtml((r.recorded_at || "").slice(11, 16))}</span>
          </button>
          <button type="button" class="btn small" data-action="request-cancel" data-visit="${escapeHtml(r.visit_id)}">${MESSAGES.cancelConfirmYes}</button>
        </li>`
        )
        .join("")}
    </ul>
  </div>`;
}

function confirmDialogHtml() {
  if (!state.confirmDialog) return "";
  return `<div class="confirm-box">
    <p>${MESSAGES.cancelConfirmTitle}</p>
    <button type="button" class="btn" data-action="confirm-cancel-yes">${MESSAGES.cancelConfirmYes}</button>
    <button type="button" class="btn" data-action="confirm-cancel-no">${MESSAGES.cancelConfirmNo}</button>
  </div>`;
}

function renderRecordScreen() {
  const rs = state.recordScreen;
  if (!rs) return renderListScreen();
  const candidate = state.candidatesById.get(rs.hojinBango);
  if (!candidate) {
    return `<div class="topbar"><button type="button" class="btn" data-action="back-to-list">${MESSAGES.btnBack}</button></div><p>${MESSAGES.candidateNotFound}</p>`;
  }
  const activeRecord = rs.activeVisitId ? state.recordsById.get(rs.activeVisitId) : null;
  const showExtra = !!(activeRecord && EXTRA_RESULT_KINDS.has(activeRecord.result));
  const todayStr = todayDateStr();
  const myTodayRecords = Array.from(state.recordsById.values())
    .filter((r) => r.hojin_bango === candidate.hojin_bango && isToday(r, todayStr) && !r.canceled)
    .sort((a, b) => (a.recorded_at || "").localeCompare(b.recorded_at || ""));

  const mapButtons = candidate.hasPosition
    ? `
    <a class="btn" href="${mapUrl(candidate, "walking")}" data-action="open-map">${MESSAGES.btnMapWalk}</a>
    <a class="btn" href="${mapUrl(candidate, "cycling")}" data-action="open-map">${MESSAGES.btnMapBike}</a>`
    : "";

  return `<div class="record-screen">
    ${fictionalBannerHtml()}
    ${storeNoteHtml()}
    <div class="topbar"><button type="button" class="btn" data-action="back-to-list">${MESSAGES.btnBack}</button></div>
    ${confirmDialogHtml()}
    <div class="record-head">
      <h1>${escapeHtml(candidate.name)}</h1>
      <p>${escapeHtml(candidate.address || "")}</p>
      <p>${escapeHtml(candidate.industry || "")}${candidate.roughPosition ? ` <span class="badge">${MESSAGES.roughPositionBadge}</span>` : ""}</p>
      ${candidate.lastResult ? `<p class="row-sub">${escapeHtml(lastResultText(candidate))}</p>` : ""}
      ${formatTimeHint(candidate.timeHint) ? `<p class="row-sub">${escapeHtml(formatTimeHint(candidate.timeHint))}</p>` : ""}
    </div>
    <div class="action-row">
      ${mapButtons}
      <button type="button" class="btn" data-action="copy-address" data-hojin="${escapeHtml(candidate.hojin_bango)}">${MESSAGES.btnCopyAddress}</button>
      <button type="button" class="btn" data-action="postpone" data-hojin="${escapeHtml(candidate.hojin_bango)}">${MESSAGES.btnPostpone}</button>
      <button type="button" class="btn" data-action="skip" data-hojin="${escapeHtml(candidate.hojin_bango)}">${MESSAGES.btnSkip}</button>
    </div>
    ${myTodayRecords.length ? todayRecordsMiniListHtml(myTodayRecords, rs) : ""}
    ${activeRecord && showExtra ? extraFieldsHtml(activeRecord) : ""}
    <div class="result-grid">
      <div class="result-row">
        <button type="button" class="btn result-btn big" data-action="result" data-result="不在">不在</button>
        <button type="button" class="btn result-btn big" data-action="result" data-result="門前払い">門前払い</button>
      </div>
      <div class="result-row">
        <button type="button" class="btn result-btn" data-action="result" data-result="名刺のみ">名刺のみ</button>
        <button type="button" class="btn result-btn" data-action="result" data-result="話せた">話せた</button>
        <button type="button" class="btn result-btn" data-action="result" data-result="再訪約束">再訪約束</button>
      </div>
    </div>
  </div>`;
}

async function renderAboutScreenAsync() {
  const app = document.getElementById("app");
  if (!app) return;
  const persisted =
    navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => null) : null;
  const recordsArr = Array.from(state.recordsById.values());
  const totalRecords = recordsArr.filter((r) => !r.canceled).length;
  const notReceived = countNotYetReceived(recordsArr, state.candidatesData?.meta?.receivedMark ?? null);
  const meta = state.candidatesData?.meta;
  const source = meta && meta.source;
  const citations = source && Array.isArray(source["文言"]) ? source["文言"] : DEFAULT_CITATIONS;

  app.innerHTML = `
    ${fictionalBannerHtml()}
    <div class="topbar"><button type="button" class="btn" data-action="back-to-list">${MESSAGES.btnBack}</button></div>
    <h1>${MESSAGES.aboutTitle}</h1>
    <p>アプリの版: ${escapeHtml(APP_VERSION)}</p>
    ${
      meta
        ? `
      <p>候補ファイルの日付: ${escapeHtml(meta.date || "")}</p>
      <p>候補ファイルの作成日時: ${escapeHtml(meta.createdAt || "")}</p>
      <p>CSVの版: ${escapeHtml(source?.["CSVの版"] ?? "")}</p>
      <p>住所辞書の版: ${escapeHtml(source?.["住所辞書の版"] ?? "")}</p>
      <p>道路網の取得日: ${escapeHtml(source?.["道路網の取得日"] ?? "")}</p>`
        : "<p>候補ファイルはまだ読み込んでいません。</p>"
    }
    <div class="citations">${citations.map((c) => `<p class="small-note">${escapeHtml(c)}</p>`).join("")}</div>
    <p>保存領域: ${persisted === null ? "確認できません" : persisted ? "消されにくい設定あり" : "消されにくい設定なし"}</p>
    <p>記録の件数: 全部 ${totalRecords}件 / Mac に届いていない ${notReceived}件</p>
    <div class="action-row">
      <button type="button" class="btn" data-action="try-fictional">${MESSAGES.btnTryFictional}</button>
      <button type="button" class="btn" data-action="end-fictional">${MESSAGES.btnEndFictional}</button>
    </div>
  `;
}

// ==================================================== イベント配線 ====

function wireEvents() {
  const app = document.getElementById("app");
  app.addEventListener("click", onAppClick);
  app.addEventListener("change", onAppChange);
  app.addEventListener("input", onAppInput);
  const toastEl = document.getElementById("toast");
  if (toastEl) {
    toastEl.addEventListener("click", (ev) => {
      if (ev.target.closest('[data-action="toast-undo"]')) handleImmediateUndo(state.toast.visitId);
    });
  }
  // ファイルの選択欄は index.html に固定で置いてある(#app の描き直しで消えないように)。
  const fileInput = document.getElementById("file-input");
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = ""; // 同じファイルをもう一度選んでも読めるように
      if (file) handleFileChosen(file);
    });
  }
}

function onAppClick(ev) {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  const hojin = el.dataset.hojin;
  const visit = el.dataset.visit;
  switch (action) {
    case "rebuild":
      handleRebuild();
      break;
    case "export":
      handleExport();
      break;
    case "about":
      state.screen = "about";
      render();
      break;
    case "back-to-list":
      goToList();
      break;
    case "open-record":
      openRecordScreen(hojin);
      break;
    case "result":
      handleResultTap(el.dataset.result);
      break;
    case "postpone":
      postponeCandidate(hojin);
      break;
    case "skip":
      skipCandidate(hojin);
      break;
    case "restore-skipped":
      restoreFromSkipped(hojin);
      break;
    case "toggle-skipped":
      state.skippedOpen = !state.skippedOpen;
      render();
      break;
    case "copy-address":
      copyAddress(state.candidatesById.get(hojin));
      break;
    case "open-map":
      scheduleMapOpenCheck(); // href の遷移はそのまま進める(preventDefaultしない)
      break;
    case "edit-record":
      openEditRecord(visit);
      break;
    case "request-cancel":
      requestCancelConfirm(visit);
      break;
    case "confirm-cancel-yes":
      confirmCancelRecord();
      break;
    case "confirm-cancel-no":
      cancelConfirmDialog();
      break;
    case "field-choice":
      handleFieldChoice(el.dataset.field, el.dataset.choice);
      break;
    case "try-fictional":
      tryFictionalSample();
      break;
    case "end-fictional":
      endFictionalMode();
      break;
    default:
      break;
  }
}

function onAppChange(ev) {
  if (ev.target && ev.target.dataset && ev.target.dataset.action === "field-revisit") {
    handleRevisitChange(ev.target.value);
  }
}

function onAppInput(ev) {
  const action = ev.target && ev.target.dataset && ev.target.dataset.action;
  if (action === "field-reaction") handleTextFieldInput("reaction", ev.target);
  if (action === "field-url") handleTextFieldInput("url", ev.target);
}

// ==================================================== 起動(ブラウザ限定) ====

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}
