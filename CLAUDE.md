# fanbox-downloader

pixiv FANBOX の投稿をZIPとして一括ダウンロードするブックマークレット。
[darekasan/fanbox-downloader](https://github.com/darekasan/fanbox-downloader) → [furubarug](https://github.com/furubarug/fanbox-downloader) → 本リポジトリ の順でforkしたもの。

## コマンド

- `bun run build` — `bun build --minify` で `fanbox-downloader.ts` → `docs/fanbox-downloader.min.js` にバンドル
- `bun run lint` — Biome による静的解析・フォーマット修正
- `bun run typecheck` — tsc による型検査 (ビルドは bun build が行うため `--noEmit`)
- `bun test` — ユニットテストを実行

## プロジェクト構成

- `fanbox-downloader.ts` の単一ファイル構成 (エントリポイントは `export main()`)
- ビルド成果物 `docs/fanbox-downloader.min.js` は CI が生成するため git 管理対象外。ローカルで `bun run build` しても commit には現れない
- FANBOX API の型定義と収集ロジックは `download-helper/fanbox-collector` にあり、このリポジトリにローカルの型定義ファイルは無い (`fanbox-downloader-extension` と共用)

## 技術スタック

- Bun でバンドル + ミニファイ (TypeScript → ESM)、Biome で静的解析・フォーマット
- tsconfig.json はビルドには使わず、エディタの型チェック用に維持している
- 唯一の runtime 依存は `download-helper` (GitHub の git tag から取得。バージョンは package.json が SoT)

## アーキテクチャ

- `main()` — ブックマークレットのエントリポイント。URL パターンで動作を分岐
  - `downloads.fanbox.cc` → DownloadHelper UI を起動（download-helper パッケージ）
  - `*.fanbox.cc` / `fanbox.cc/@*` → 投稿情報を収集してクリップボードにコピー
- `DownloadManage` クラス・`addByPostInfo`（postInfo → DownloadObject への変換）は
  `download-helper/fanbox-collector` から import する共有ロジック
  （投稿一覧取得・ページネーションなど API 呼び出し自体はこのリポジトリ固有の実装として残る）
- 検証境界は共有層の `addByPostInfo` の入口にある (ValerianDillon/download-helper#30)。
  このリポジトリの取得関数が保証するのは収集の分岐に使うフィールドだけで
  (`getPostInfoById` は `id` / `type` / `isRestricted`、一覧要素は `id` / `isRestricted` / `feeRequired`)、
  戻り値の型も `PostInfoCandidate` / `PostListItemCandidate` として「検証済み」を名乗らない。
  本文の検証は `addByPostInfo` が入口で行う
- `addByPostInfo` が投稿の `publishedDatetime` を `postObject.setPublishedDatetime` で記録するため、
  ZIP 内の各ファイル・フォルダの mtime に投稿日時が反映される
- FANBOX API (`api.fanbox.cc`) の呼び出しは `ApiSession` に集約する。収集ごとに作り、前回引き上がった発行間隔を持ち越さない
  - 全エンドポイントを通し、待機だけでなく発行から応答処理までを直列化する。ゲートだけ排他化すると、待機を終えた複数の呼び出しが同時に発行されうる
  - transport の結果を `response` (status を持つ) と `unobservable-failure` に正規化する。CORS 失敗や通信断では status を推測しない
  - exact 429 は `Retry-After` が読めればそれに従い、読めなければ 5 / 15 / 45 秒で 3 回再試行する
  - 観測できない失敗は 5 / 15 秒で 2 回だけ再試行する。ここにはオフラインや一時的な通信障害が多く含まれ、長く待つ根拠となる観測情報が無いため
  - 発行間隔の引き上げは exact 429 の観測だけを根拠にする。通信障害をレート制限として学習しないため
  - 再試行枠を使い切ったら次の要求へ進まず収集を停止する。集めた分は捨てず、不完全と明示して返す
  - ページ origin では `Retry-After` は CORS セーフリスト外なので通常は読めない。それでも読みに行くのは、サーバが `Access-Control-Expose-Headers` を返すようになれば実装を変えずに使えるようにするため
  - 想定外の例外を投稿単位・ページ単位の失敗に丸めない。投稿単位・ページ単位の失敗として数えてよいのは `HttpError` だけで、実装上のバグを通信障害として数えると原因の分類を誤ったまま収集を続けてしまう
- 配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。形状が想定と違うとき、
  プラン名とタグは表示の補助なので握りつぶして続行し、投稿一覧と投稿詳細は
  `ApiShapeError` で中止して結果自体を返さない (途中までの結果を成功として出さないため)
- 投稿一覧に本文は含まれないため、閲覧できる投稿はすべて `post.info` を個別に叩く。
  ただし一覧の時点で `isIgnoreFree` の対象、または `isRestricted` と分かる投稿は叩かない
  (投稿ごとに 1 リクエスト削減できる。`addByPostInfo` 側の判定は単一投稿モードと
  権限変化のための防御として残す)
- `addByPostInfo` の結果 (`AddPostResult`) は exhaustive な `switch` で処理し、取得できなかった
  投稿は理由別に数えて alert で通知する (`addByPostInfo` が黙って読み飛ばすため、数えないと
  全投稿が消えても気付けない)
  - `restricted` / `missing-body` / `unsupported` / ページ単位の失敗を合算しない。
    単位と対処が違い、とくにページ単位の失敗は欠落した投稿数が不明なため
  - alert は「確認が必要な未取得」を先に、「閲覧条件による未取得」を後に置く
    (`restricted` は正常系でも大量に出るので、混ぜると異常が埋もれる)
  - alert に原因は書かない。`missing-body` には本文の欠落と、詳細取得が HTTP エラーだった投稿が合流しており、件数からは識別できないため断定すると誤誘導になる (通信の失敗と CORS は再試行を経て枯渇として伝播するので、ここには来ない)
  - `invalid` (既知の投稿タイプなのに読むべきフィールドが欠けている) は投稿単位の失敗に数えず、
    `PostBodyInvalidError` で収集全体を中断する。`ApiShapeError` とは検出層が違うので型は分け、
    捕捉は `isCollectionAbortError` にまとめる
- 中断の扱いは一覧モードと単一投稿モードで揃える (どちらも同じ alert を出して結果を返さない)
- 失敗種別の判定 (握りつぶして続行するか、収集を止めるか) は名前の付いた述語に集約する (`isCollectionAbortError` など)。catch に `instanceof` の型リストを直書きすると、共有層でエラー型が増えたり分かれたりしたときに一部の catch だけ取り残される

## コーディング規約

- Biome (recommended ルールセット) で強制。設定は `biome.json` が SoT

## Git運用

- fork なので `upstream` (furubarug/fanbox-downloader) が残してある。上流の変更取り込み用
- **`gh pr create` は fork 元 (upstream) をデフォルトのベースリポジトリにする。** 必ず `--repo ValerianDillon/fanbox-downloader --base master` を指定すること
- マージは squash。`master` の履歴は `<タイトル> (#21)` の形の単一コミットで揃える
