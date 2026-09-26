"use strict";
/**
 * files.js ── Mac とやり取りするファイルの形(設計 §2、IP-01・IP-10・IP-13)。DOM に触れない。
 *
 * 実現する設計項目/要件ID:
 *  - IP-01 / REQ-049・051、ADR-015:候補のファイルを読む。前日のままなら判定用の状態を返す
 *  - IP-10 / REQ-048・053:復元のファイルを読む
 *  - IP-13 / ADR-024:候補ファイルの「架空」フラグを見分ける
 *  - REQ-013 §1-1(D1 #6):法人番号・商号が無い行は除いて数える。緯度経度が数値でない行は位置不明
 *  - REQ-017 §1-1・§1-3 相当(D1 #11 に合わせた文言はapp.js側):JSONとして読めない/版不一致を判定
 *
 * ここでは「ファイルの中身をどう解釈するか」だけを扱い、実際の入力(<input type=file>)や
 * IndexedDB への保存は app.js / store.js が行う。返り値は { ok:true, value } か
 * { ok:false, error } のどちらか(error は app.js が画面文言にマップする)。
 */

/** JSON テキストを解釈し、種類(candidates/restore)ごとに振り分ける。 */
export function parseIncomingFile(rawText) {
  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, error: "invalid_json" };
  }
  const kind = json["種類"];
  if (kind === "candidates") {
    const result = parseCandidatesJson(json);
    return result.ok ? { ...result, kind: "candidates" } : result;
  }
  if (kind === "restore") {
    const result = parseRestoreJson(json);
    return result.ok ? { ...result, kind: "restore" } : result;
  }
  return { ok: false, error: "unknown_kind" };
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 候補のファイル(設計§2-1)を解釈する。
 * - 版が1でなければ拒否。
 * - 行に法人番号・商号のどちらか欠ければ、その行は除いて badRowCount に数える(D1 #6)。
 * - 緯度・経度が数値でなければ位置不明として扱う(hasPosition=false)。
 * - 「位置が粗い」は明示フラグ(任意・後方互換)または位置精度が「町丁目まで」のとき true。
 * - 道のりの表はここでは形を確かめない(route.js が n×n かどうかを見て使う/使わないを決める)。
 */
export function parseCandidatesJson(json) {
  if (json["版"] !== 1) return { ok: false, error: "unsupported_version" };

  const rawList = Array.isArray(json["候補"]) ? json["候補"] : [];
  const candidates = [];
  let badRowCount = 0;

  rawList.forEach((row, index) => {
    if (!row || typeof row !== "object" || !row["法人番号"] || !row["商号"]) {
      badRowCount += 1;
      return;
    }
    const latRaw = row["緯度"];
    const lonRaw = row["経度"];
    const hasPosition = isFiniteNumber(latRaw) && isFiniteNumber(lonRaw);
    const geoLevel = hasPosition ? row["位置精度"] || "不明" : "不明";
    const roughFlag = row["位置が粗い"] === true; // 後方互換:古いファイルには無い(★coordinator追加)
    candidates.push({
      matrixIndex: index, // 道のりの表(元のファイルの行数=n)との対応に使う
      hojin_bango: row["法人番号"],
      name: row["商号"],
      address: row["所在地"] ?? null,
      block: row["ブロック"] ?? null,
      industry: row["業種"] ?? null,
      lat: hasPosition ? latRaw : null,
      lon: hasPosition ? lonRaw : null,
      hasPosition,
      geoLevel,
      roughPosition: roughFlag || geoLevel === "町丁目まで",
      timeHint: row["時間帯の目安"] ?? null,
      reason: row["出た理由"] ?? null,
      lastResult: row["前回の結果"] ?? null,
      revisitAt: row["再訪約束の日時"] ?? null,
    });
  });

  const rawMatrix = json["道のりの表"];

  return {
    ok: true,
    value: {
      isFictional: json["架空"] === true,
      meta: {
        date: json["日付"] ?? null,
        createdAt: json["作成日時"] ?? null,
        source: json["出典"] ?? null,
        receivedMark: json["受け取り済みの印"] ?? null,
      },
      candidates,
      badRowCount,
      matrixDimension: rawList.length,
      matrix: Array.isArray(rawMatrix) ? rawMatrix : null,
    },
  };
}

/** 復元のファイル(設計§2-3)を解釈する。visit_id を持たない行は無視する(防御的)。 */
export function parseRestoreJson(json) {
  if (json["版"] !== 1) return { ok: false, error: "unsupported_version" };
  const rawList = Array.isArray(json["records"]) ? json["records"] : [];
  const records = rawList.filter((r) => r && typeof r === "object" && r["visit_id"]);
  return {
    ok: true,
    value: {
      meta: {
        createdAt: json["作成日時"] ?? null,
        targetDate: json["対象日"] ?? null,
      },
      records,
      rawCount: rawList.length,
    },
  };
}

/**
 * 候補の日付が今日に対してどこにあるか(IP-01・ADR-015)。
 * 文字列は YYYY-MM-DD 形式である前提(辞書順比較で前後が決まる)。
 */
export function candidateFreshness(candidateDateStr, todayStr) {
  if (!candidateDateStr) return "unknown";
  if (candidateDateStr < todayStr) return "past";
  if (candidateDateStr > todayStr) return "future";
  return "today";
}
