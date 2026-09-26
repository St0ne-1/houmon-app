"use strict";
/**
 * route.js ── 並べ方(設計 §5、IP-02・IP-03)。DOM に触れない純粋関数のみ。
 *
 * 実現する設計項目/要件ID:
 *  - IP-03 / REQ-030・033・051:現在地から並べ直す(直線で起点→道のりの表で貪欲につなぐ)
 *  - ADR-007・016:道のりの表が使えない/欠けている組は直線距離で代える(欠測のみ×1.4)
 *  - REQ-013 §1-1(D1 #6):道のりの表が n×n でなければ使わず、直線距離で並べる
 *
 * 候補の並びは常に「候補ファイルの元の並び順」(matrixIndex 昇順)を保つ。
 * 距離が同着のときは、その並び順が早いものを選ぶ(2026-09-26 コーディネーター追加指示)。
 * distance_table.matrix[i][j] は Mac 側 (mac/houmon/walk.py) の作りに合わせ、
 * 位置不明な組・非連結な組は null。
 */

// Mac 側 mac/houmon/planner.py の _meters と同じ近似(1度あたり緯度111km・経度は緯度で縮める)。
const METERS_PER_DEGREE_LAT = 110_540.0;
const METERS_PER_DEGREE_LON_AT_EQUATOR = 111_320.0;

/** 2点間の直線距離(m)。緯度経度から近似。 */
export function haversineMeters(a, b) {
  const meanLatRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lon - a.lon) * METERS_PER_DEGREE_LON_AT_EQUATOR * Math.cos(meanLatRad);
  const dy = (b.lat - a.lat) * METERS_PER_DEGREE_LAT;
  return Math.hypot(dx, dy);
}

/** 道のりの表が n×n の形をしているか(REQ-013 §1-1 D1 #6・設計§5)。 */
export function isValidMatrixShape(matrix, n) {
  if (n === 0) return Array.isArray(matrix) && matrix.length === 0;
  if (!Array.isArray(matrix) || matrix.length !== n) return false;
  return matrix.every((row) => Array.isArray(row) && row.length === n);
}

function matrixCellValue(matrix, i, j) {
  const row = matrix ? matrix[i] : undefined;
  const v = row ? row[j] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 2候補間の「並べるときに使う距離」。
 * 表が使えるとき:セルの値があればそれを使い、無ければ直線距離×1.4(設計§5-4「★」)。
 * 表が使えない(壊れている)とき:常に直線距離(倍率なし。設計§5「道のりの表が壊れている」)。
 */
export function effectiveDistance(matrixCtx, i, j, pointI, pointJ) {
  const straight = haversineMeters(pointI, pointJ);
  if (!matrixCtx || !matrixCtx.matrixUsable) return straight;
  const cell = matrixCellValue(matrixCtx.matrix, i, j);
  return cell !== null ? cell : straight * 1.4;
}

/**
 * 現在地から直線でいちばん近い候補を選ぶ(ADR-016 手順3)。
 * 同着(0mを含む)は候補ファイルの並び順が早い方を選ぶ(items は呼び出し側で
 * matrixIndex 昇順に保つこと。厳密な `<` 比較により先着が残る)。
 */
export function nearestByStraightLine(point, items) {
  let best = null;
  let bestDistance = Infinity;
  for (const item of items) {
    const d = haversineMeters(point, { lat: item.lat, lon: item.lon });
    if (d < bestDistance) {
      bestDistance = d;
      best = item;
    }
  }
  return best;
}

/**
 * 始点から、残りの候補を「道のりの表でいちばん近いもの」へ次々つなぐ(貪欲最近傍)。
 * 同着は候補ファイルの並び順が早い方(items の並びで先に出てくる方)を選ぶ。
 */
function chainGreedy(startItem, items, matrixCtx) {
  const remaining = items.slice();
  const order = [];
  let current = startItem;
  while (remaining.length > 0) {
    let bestIdx = -1;
    let bestDistance = Infinity;
    for (let idx = 0; idx < remaining.length; idx += 1) {
      const candidate = remaining[idx];
      const d = effectiveDistance(matrixCtx, current.matrixIndex, candidate.matrixIndex, current, candidate);
      if (d < bestDistance) {
        bestDistance = d;
        bestIdx = idx;
      }
    }
    const [next] = remaining.splice(bestIdx, 1);
    order.push(next);
    current = next;
  }
  return order;
}

function toIdList(items) {
  return items.map((c) => c.hojin_bango);
}

/**
 * 新しい候補ファイルを読んだときの初期の並び(設計§5「新しい候補のファイルを読んだとき」)。
 * ファイルの順そのまま(Mac が前夜に作った順)。位置の無い候補は「位置不明」の区分に
 * 出すので、回る順には入れない(二重に出さない)。
 */
export function initialOrder(candidates) {
  return toIdList(candidates.filter((c) => c.hasPosition));
}

/**
 * 「現在地から並べ直す」(IP-03・REQ-030・033・051)。
 *
 * @param {object} args
 * @param {Array} args.candidates - files.js が返す正規化済み候補(matrixIndex 昇順)
 * @param {number} args.matrixDimension - 元の候補ファイルの行数(道のりの表の n)
 * @param {Array|null} args.matrix - 道のりの表(生の配列。null なら「無い」扱い)
 * @param {{lat:number, lon:number}|null} args.currentPosition - 現在地(直線起点用)
 * @param {Set<string>|Array<string>} args.recordedIds - 今日記録済みの法人番号
 * @param {Set<string>|Array<string>} args.postponedIds - 後回しの法人番号
 * @param {Set<string>|Array<string>} args.skippedIds - スキップの法人番号
 * @returns {{mainOrder:string[], postponedOrder:string[], usedStraightLineFallback:boolean}}
 */
export function buildRoute({
  candidates,
  matrixDimension,
  matrix,
  currentPosition,
  recordedIds,
  postponedIds,
  skippedIds,
}) {
  const recorded = recordedIds instanceof Set ? recordedIds : new Set(recordedIds || []);
  const postponed = postponedIds instanceof Set ? postponedIds : new Set(postponedIds || []);
  const skipped = skippedIds instanceof Set ? skippedIds : new Set(skippedIds || []);

  const matrixUsable = isValidMatrixShape(matrix, matrixDimension);
  const matrixCtx = { matrix, matrixUsable };

  const withPosition = candidates.filter((c) => c.hasPosition);
  const isUntouched = (c) => !recorded.has(c.hojin_bango) && !postponed.has(c.hojin_bango) && !skipped.has(c.hojin_bango);

  // 対象=位置のある候補のうち、今日記録していない・後回しでない・スキップでないもの(設計§5手順2)。
  const mainEligible = withPosition.filter((c) => isUntouched(c));
  // 後回しの候補(記録済み・スキップは除く。設計§5手順5)。
  const postponedEligible = withPosition.filter(
    (c) => postponed.has(c.hojin_bango) && !recorded.has(c.hojin_bango) && !skipped.has(c.hojin_bango)
  );

  let mainOrderItems = [];
  if (mainEligible.length > 0) {
    const start = currentPosition
      ? nearestByStraightLine(currentPosition, mainEligible)
      : mainEligible[0];
    const rest = mainEligible.filter((c) => c !== start);
    mainOrderItems = [start, ...chainGreedy(start, rest, matrixCtx)];
  }

  let postponedOrderItems = [];
  if (postponedEligible.length > 0) {
    if (mainOrderItems.length > 0) {
      // 回る順の最後の候補から同じやり方でつなぐ(設計§5手順5)。
      const chainStart = mainOrderItems[mainOrderItems.length - 1];
      postponedOrderItems = chainGreedy(chainStart, postponedEligible, matrixCtx);
    } else {
      // 回る順が空(全部後回し等)のときの手当て:後回し自身の中で現在地から並べる(★解釈)。
      const start = currentPosition
        ? nearestByStraightLine(currentPosition, postponedEligible)
        : postponedEligible[0];
      const rest = postponedEligible.filter((c) => c !== start);
      postponedOrderItems = [start, ...chainGreedy(start, rest, matrixCtx)];
    }
  }

  return {
    mainOrder: toIdList(mainOrderItems),
    postponedOrder: toIdList(postponedOrderItems),
    usedStraightLineFallback: !matrixUsable,
  };
}

/** 連続する2候補間の「次まで◯m」表示用(表に無ければ null=出さない。設計§4-1)。 */
export function nextLegMeters(matrix, matrixDimension, fromCandidate, toCandidate) {
  if (!isValidMatrixShape(matrix, matrixDimension)) return null;
  return matrixCellValue(matrix, fromCandidate.matrixIndex, toCandidate.matrixIndex);
}
