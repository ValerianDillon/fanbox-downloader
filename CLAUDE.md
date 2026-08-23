# fanbox-downloader

pixiv FANBOX の投稿を ZIP として一括ダウンロードするブックマークレット。
[darekasan](https://github.com/darekasan/fanbox-downloader) → [furubarug](https://github.com/furubarug/fanbox-downloader) → 本リポジトリ の順で fork した。

FANBOX API の型定義、収集ロジック (`addByPostInfo`)、レート制御 (`ApiSession`)、ZIP 生成は `download-helper` にある (Chrome 拡張版 fanbox-downloader-extension と共用)。このリポジトリ固有なのは、投稿一覧の取得・ページネーション・UI 通知。

## コマンド

- `bun run build` — `docs/fanbox-downloader.min.js` にバンドル。成果物は CI が生成するため git 管理対象外
- `bun run lint` / `bun run typecheck`
- `bun test` — ユニットテスト

## エントリポイント

`main()` が URL パターンで動作を分岐する。

- `downloads.fanbox.cc` → DownloadHelper の UI を起動
- `*.fanbox.cc` / `fanbox.cc/@*` → 投稿情報を収集してクリップボードにコピー

## 収集と検証

- **検証境界は共有層の `addByPostInfo` の入口にある** (ValerianDillon/download-helper#30)。このリポジトリの取得関数が保証するのは収集の分岐に使うフィールドだけで、戻り値の型も「検証済み」を名乗らない (`PostInfoCandidate` / `PostListItemCandidate`)
- 投稿一覧に本文は含まれないため、閲覧できる投稿はすべて `post.info` を個別に叩く
  - ただし一覧の時点で `isIgnoreFree` の対象、または `isRestricted` と分かる投稿は叩かない (投稿ごとに 1 リクエスト削減できる)
  - `addByPostInfo` 側の同じ判定は、単一投稿モードと権限変化のための防御として残す
- 配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。形状が想定と違うとき、プラン名とタグは表示の補助なので握りつぶして続行し、投稿一覧と投稿詳細は `ApiShapeError` で中止して結果自体を返さない (途中までの結果を成功として出さないため)
- `addByPostInfo` が `publishedDatetime` を記録するため、ZIP 内の各ファイル・フォルダの mtime に投稿日時が反映される
- ZIP のルートに `download-manifest.json` が入る (ValerianDillon/download-helper#42)。`stringify()` は「全件を選択した projection」なので、その記録が書き出される。このリポジトリは絞り込み UI を持たないので常に全件

## レート制御

FANBOX API (`api.fanbox.cc`) の呼び出しは `ApiSession` に集約する。収集ごとに作り、前回引き上がった発行間隔を持ち越さない。再試行回数や待機秒数の具体値は共有層の JSDoc が SoT。

- **全エンドポイントを通し、待機だけでなく発行から応答処理までを直列化する。** ゲートだけ排他化すると、待機を終えた複数の呼び出しが同時に発行されうる
- transport の結果を `response` (status を持つ) と `unobservable-failure` に正規化する。**CORS 失敗や通信断では status を推測しない**
- 観測できない失敗は exact 429 より短く切り上げる。オフラインや一時的な通信障害が多く含まれ、長く待つ根拠となる観測情報が無いため
- **発行間隔の引き上げは exact 429 の観測だけを根拠にする。** 通信障害をレート制限として学習しないため
- 再試行枠を使い切ったら次の要求へ進まず収集を停止する。集めた分は捨てず、不完全と明示して返す
- ページ origin では `Retry-After` は CORS セーフリスト外なので通常は読めない。それでも読みに行くのは、サーバが `Access-Control-Expose-Headers` を返すようになれば実装を変えずに使えるようにするため

## 失敗の扱い

**想定外の例外を投稿単位・ページ単位の失敗に丸めない。** 投稿単位・ページ単位の失敗として数えてよいのは `HttpError` だけで、実装上のバグを通信障害として数えると原因の分類を誤ったまま収集を続けてしまう。

- `invalid` (既知の投稿タイプなのに読むべきフィールドが欠けている) は投稿単位の失敗に数えず、`PostBodyInvalidError` で収集全体を中断する。`ApiShapeError` とは検出層が違うので型は分け、捕捉は `isCollectionAbortError` にまとめる
- **失敗種別の判定は名前の付いた述語に集約する** (`isCollectionAbortError` など)。catch に `instanceof` の型リストを直書きすると、共有層でエラー型が増えたり分かれたりしたときに一部の catch だけ取り残される
- 中断の扱いは一覧モードと単一投稿モードで揃える (どちらも同じ alert を出して結果を返さない)

### 未取得の通知

`AddPostResult` は exhaustive な `switch` で処理し、取得できなかった投稿は理由別に数えて alert で通知する。`addByPostInfo` は黙って読み飛ばすため、数えないと全投稿が消えても気付けない。

- `restricted` / `missing-body` / `unsupported` / ページ単位の失敗を**合算しない**。単位と対処が違い、とくにページ単位の失敗は欠落した投稿数が不明
- alert は「確認が必要な未取得」を先に、「閲覧条件による未取得」を後に置く。`restricted` は正常系でも大量に出るので、混ぜると異常が埋もれる
- **alert に原因は書かない。** `missing-body` には本文の欠落と、詳細取得が HTTP エラーだった投稿が合流しており、件数からは識別できない。断定すると誤誘導になる (通信の失敗と CORS は再試行を経て枯渇として伝播するので、ここには来ない)

## コーディング規約

Biome (recommended ルールセット) で強制。設定は `biome.json` が SoT。

## Git 運用

- **`upstream` remote は置かない。** fork だが上流の変更を取り込む予定はない
  - `upstream` があると `gh` の既定リポジトリが fork 元へ解決され、`gh issue list` / `gh issue view` が他人のリポジトリの Issue を返す。書き込みの誤爆につながる
  - 必要になったときも remote は足さず URL 直指定で fetch する
  - 併せて `gh repo set-default ValerianDillon/fanbox-downloader` を設定してある。クローンし直したら再設定する
- 既定ブランチは `master`。`gh pr create` の `--base` は省略してよい (`--base main` は download-helper 側の慣習で、ここでは失敗する)
- マージは squash。`master` の履歴は `<タイトル> (#21)` の形の単一コミットで揃える
