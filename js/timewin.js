"use strict";
/**
 * timewin.js ── 時間帯の窓の判定(設計 §5「時間帯の窓」、IP-02、REQ-023・ADR-023)。
 * DOM に触れない純粋関数のみ。文言(日本語の曜日名など)は持たない(app.js に集約)。
 *
 * 候補が持つ「時間帯の目安」は Mac が前夜に付けたもの(候補ごとに固定)。
 * ここでは「いまの時刻がその窓に入るか」だけを判定する(前夜には時刻を見ない=ADR-023)。
 */

const WEEKDAY_CODES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** JS の Date から Mac 側と同じ曜日コード("Sun"〜"Sat")を得る。 */
export function weekdayCode(date) {
  return WEEKDAY_CODES[date.getDay()];
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
}

/**
 * hint = {windows:[[start,end],...], avoid_weekdays:[...], note} または null。
 * null(時間帯の目安が無い候補)は「どちらにも当たらない」= false(設計§5)。
 * 窓は開始・終了とも含む(閉区間)。avoid_weekdays に今日が入っていれば false。
 */
export function matchesWindow(hint, now) {
  if (!hint || !Array.isArray(hint.windows) || hint.windows.length === 0) return false;
  const avoid = Array.isArray(hint.avoid_weekdays) ? hint.avoid_weekdays : [];
  if (avoid.includes(weekdayCode(now))) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return hint.windows.some(([start, end]) => {
    const s = toMinutes(start);
    const e = toMinutes(end);
    return nowMinutes >= s && nowMinutes <= e;
  });
}

/**
 * 一覧の区分1(いま会えそう)・区分2(回る順)への分割(設計§4-1)。
 * 回る順そのもの(並び順)は変えない。1件も無い、または全部が該当するときは
 * 区分を分けず「回る順」だけにする(設計§4-1「1に入るものが無い、または〜」)。
 *
 * @param {Array} orderedList - 回る順に並んだ候補(または候補のID等、任意の要素)
 * @param {Date} now
 * @param {(item:any) => object|null} getHint - 要素から時間帯の目安を取り出す関数
 */
export function splitByAvailability(orderedList, now, getHint = (c) => c.timeHint) {
  const imminent = orderedList.filter((c) => matchesWindow(getHint(c), now));
  if (imminent.length === 0 || imminent.length === orderedList.length) {
    return { imminent: [], rest: orderedList.slice() };
  }
  const imminentSet = new Set(imminent);
  const rest = orderedList.filter((c) => !imminentSet.has(c));
  return { imminent, rest };
}
