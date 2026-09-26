# app/ ── 公開の置き場に出すのはこの中身だけ

このフォルダの中身(HTML・CSS・JavaScript・アイコン・架空データ)が、そのまま公開の置き場
(ADR-024。GitHub Pages)に載る。商号・住所・訪問記録は一切入れない。

- `index.html` / `style.css` / `manifest.json` / `sw.js` / `icon.png` … 画面とオフライン対応
- `sample_candidates.json` … 「架空の候補で試す」(このアプリについて画面)が読み込む架空データ
- `js/` … 部品(`app.js` が画面と操作、ほかはDOMに触れない純粋なロジック)

手元での確かめ方・テストの実行方法は1つ上の `iphone/README.md` を見ること。
