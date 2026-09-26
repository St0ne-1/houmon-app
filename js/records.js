"use strict";
/**
 * records.js ── 記録の作成・修正・まとめ(設計 §2-2・§4-2・§6、IP-05〜IP-10)。DOM に触れない。
 *
 * 実現する設計項目/要件ID:
 *  - IP-05 / REQ-007・036・042、D1 #3:5段階の記録を1件作る(record_seconds を含む)
 *  - IP-06 / REQ-015・037・039・043:追加項目の設定・複数選択の切り替え
 *  - IP-07 / REQ-038:時刻(自動)・位置(あとから書き足す)
 *  - IP-08 / REQ-040:修正(updated_at を入れる)・取り消し(canceled=1)
 *  - IP-09 / REQ-049・052:Mac に届いていない記録+今日の記録を書き出す形を作る
 *  - IP-10 / REQ-048:復元のマージ(新しい方=updated_at/recorded_atが後の方を残す)
 *
 * 時刻はすべて端末の地方時 `YYYY-MM-DDTHH:MM:SS`(時差の表記なし。toISOString は使わない=UTCになるため)。
 */

const MAX_TEXT_LENGTH = 500;

export function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 端末の地方時 YYYY-MM-DDTHH:MM:SS(タスク指示の必須フォーマット)。 */
export function formatLocalDateTime(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/** 再訪約束の日時 YYYY-MM-DDTHH:MM(秒を持たない)。 */
export function formatLocalDateTimeMinute(date) {
  return formatLocalDateTime(date).slice(0, 16);
}

/**
 * 結果を押した直後の記録を1件作る(IP-05)。
 * record_seconds = 画面を開いてから押すまでの秒数(小数1桁。設計§4-2)。
 */
export function createRecord({ visitId, hojinBango, result, openedAtMs, nowDate }) {
  const nowStr = formatLocalDateTime(nowDate);
  const rawSeconds = Math.max(0, (nowDate.getTime() - openedAtMs) / 1000);
  return {
    visit_id: visitId,
    hojin_bango: hojinBango,
    visited_at: nowStr,
    result,
    recorded_at: nowStr,
    rec_lat: null,
    rec_lon: null,
    branches: null,
    reaction: null,
    url: null,
    revisit_at: null,
    met_with: null,
    president_time: null,
    industry_fix: null,
    role: null,
    doc_volume: null,
    record_seconds: Math.round(rawSeconds * 10) / 10,
    canceled: 0,
    updated_at: null,
  };
}

/** 同じ画面のうちに別の結果を押したとき:新しい記録を作らず結果だけ変える(設計§4-2★)。 */
export function changeResult(record, newResult, nowDate) {
  return { ...record, result: newResult, updated_at: formatLocalDateTime(nowDate) };
}

/** 位置はあとから取りに行って書き足す(IP-07・ADR-015の4)。 */
export function setPosition(record, lat, lon) {
  return { ...record, rec_lat: lat, rec_lon: lon };
}

/** 追加項目を1つ設定する(押すたびに上書き保存。updated_at を入れる)。 */
export function setField(record, field, value, nowDate) {
  return { ...record, [field]: value, updated_at: formatLocalDateTime(nowDate) };
}

/** 単一選択の項目の「もう一度押すと外れる」動作。 */
export function toggleSingleChoice(current, choice) {
  return current === choice ? null : choice;
}

/** 「社長のいる時間帯」はいくつでも選べ、「・」でつないで保存する(ADR-010)。 */
export function togglePresidentTime(current, choice) {
  const parts = current ? String(current).split("・").filter(Boolean) : [];
  const idx = parts.indexOf(choice);
  if (idx >= 0) {
    parts.splice(idx, 1);
  } else {
    parts.push(choice);
  }
  return parts.length ? parts.join("・") : null;
}

/** メモ・URL の500文字上限に達しているか(D1 #2 案A)。 */
export function isAtTextLimit(value, max = MAX_TEXT_LENGTH) {
  return typeof value === "string" && value.length >= max;
}

/** 500文字を超える分は保存前に切り詰める(入力欄側の maxlength と二重の安全策)。 */
export function clampText(value, max = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return value;
  return value.length > max ? value.slice(0, max) : value;
}

/** 記録の取り消し(直後のワンタップ、またはあとからの確認つき取り消しの両方で使う)。 */
export function cancelRecord(record, nowDate) {
  return { ...record, canceled: 1, updated_at: formatLocalDateTime(nowDate) };
}

/** Mac に届いていない記録か(設計§6:updated_atまたはrecorded_atが受け取り済みの印より後)。 */
export function isNotYetReceived(record, receivedMark) {
  const mtime = record.updated_at || record.recorded_at;
  if (!receivedMark) return true;
  return mtime > receivedMark;
}

/** その記録が指定日(YYYY-MM-DD)の訪問か(訪問日時=visited_atの日付部分で判定)。 */
export function isToday(record, todayStr) {
  return typeof record.visited_at === "string" && record.visited_at.slice(0, 10) === todayStr;
}

/** 今日・取り消していない記録の件数(一覧の帯「今日の記録◯件」用)。 */
export function countToday(records, todayStr) {
  return records.filter((r) => !r.canceled && isToday(r, todayStr)).length;
}

/** Mac に届いていない・取り消していない記録の件数(一覧の帯用)。 */
export function countNotYetReceived(records, receivedMark) {
  return records.filter((r) => !r.canceled && isNotYetReceived(r, receivedMark)).length;
}

/** 法人番号ごとの「今日のいちばん新しい記録」(一覧の区分6の表示用。取り消しは除く)。 */
export function latestTodayRecordByCorp(records, todayStr) {
  const map = new Map();
  for (const r of records) {
    if (r.canceled) continue;
    if (!isToday(r, todayStr)) continue;
    const cur = map.get(r.hojin_bango);
    if (!cur || (r.recorded_at || "") >= (cur.recorded_at || "")) {
      map.set(r.hojin_bango, r);
    }
  }
  return map;
}

/** 書き出しファイル名(設計§2-2・§9。架空モードは records_kakuu_… にする)。 */
export function buildExportFileName(nowDate, isFictional) {
  const stamp =
    `${nowDate.getFullYear()}-${pad2(nowDate.getMonth() + 1)}-${pad2(nowDate.getDate())}` +
    `_${pad2(nowDate.getHours())}${pad2(nowDate.getMinutes())}`;
  return isFictional ? `records_kakuu_${stamp}.json` : `records_${stamp}.json`;
}

/**
 * 書き出す記録の中身を作る(IP-09)。
 * 「Mac に届いていない記録」と「今日の記録」を合わせ、visit_id で重複を除く(設計§6★)。
 * 取り消した記録も入れる(Mac 側は visit_id で1件にまとめるため、重ねて送っても増えない)。
 */
export function buildExportPayload({ records, receivedMark, todayStr, candidateDate, isFictional, nowDate }) {
  const byId = new Map();
  for (const r of records) {
    if (isNotYetReceived(r, receivedMark) || isToday(r, todayStr)) {
      byId.set(r.visit_id, r);
    }
  }
  const outRecords = Array.from(byId.values());
  const payload = {
    種類: "records",
    版: 1,
    書き出し日時: formatLocalDateTime(nowDate),
    候補の日付: candidateDate ?? null,
    records: outRecords,
  };
  if (isFictional) payload["架空"] = true;
  return { payload, fileName: buildExportFileName(nowDate, isFictional), count: outRecords.length };
}

/**
 * 復元のマージ(IP-10)。visit_id ごとに、新しい方(updated_at、無ければ recorded_at が
 * 後の方)を残す。appliedCount は実際に採用(新規追加または上書き)した件数。
 */
export function mergeRestoredRecords(existingByVisitId, restoreRecords) {
  const merged = new Map(existingByVisitId);
  let appliedCount = 0;
  for (const incoming of restoreRecords) {
    const id = incoming.visit_id;
    if (!id) continue;
    const existing = merged.get(id);
    if (!existing) {
      merged.set(id, incoming);
      appliedCount += 1;
      continue;
    }
    const incomingM = incoming.updated_at || incoming.recorded_at;
    const existingM = existing.updated_at || existing.recorded_at;
    if (incomingM && (!existingM || incomingM > existingM)) {
      merged.set(id, incoming);
      appliedCount += 1;
    }
  }
  return { merged, appliedCount };
}
