# fanbox-downloader

pixiv FANBOX の投稿をZIPとして一括ダウンロードするブックマークレット。
[darekasan/fanbox-downloader](https://github.com/darekasan/fanbox-downloader) → [furubarug](https://github.com/furubarug/fanbox-downloader) → 本リポジトリ の順でforkしたもの。

## コマンド

- `bun run build` — `bun build --minify` で `fanbox-downloader.ts` → `docs/fanbox-downloader.min.js` にバンドル
- `bun run lint` — Biome による静的解析・フォーマット修正
- `bun run typecheck` — tsc による型検査 (ビルドは bun build が行うため `--noEmit`)
- `bun test` — ユニットテストを実行

## プロジェクト構成

```
fanbox-downloader.ts    # メインソース（エントリポイント、export main()）
biome.json              # Biome 設定
.mise.toml              # mise ツールバージョン管理
docs/
  fanbox-downloader.min.js  # ビルド成果物（CI で自動生成、git 管理対象外）
  index.html                # GitHub Pages ランディングページ
  sitemap.xml
.github/
  workflows/
    deploy-pages.yml            # master push 時にビルド + Pages デプロイ
    check-download-helper.yml   # 週1回 download-helper の更新を検出して PR 作成
  dependabot.yml                # GitHub Actions の自動更新
```

- 単一ファイル構成のブックマークレット
- ビルド成果物 `docs/fanbox-downloader.min.js` は CI で自動生成されるため git 管理対象外
- FANBOX API の型定義・`DownloadManage`・`addByPostInfo`・`convert*Map` は
  `download-helper/fanbox-collector`（download-helper パッケージ内、v4.2.0〜）に集約されており、
  このリポジトリにはローカルの型定義ファイルは存在しない（`fanbox-downloader-extension` と共用）

## 技術スタック

- Bun でバンドル + ミニファイ（TypeScript → ESM）
- Biome で静的解析・フォーマット
- tsconfig.json はエディタの型チェック用に維持
- 唯一の runtime 依存: `download-helper`（GitHub の git tag `vX.X.X` から取得）

## アーキテクチャ

- `main()` — ブックマークレットのエントリポイント。URL パターンで動作を分岐
  - `downloads.fanbox.cc` → DownloadHelper UI を起動（download-helper パッケージ）
  - `*.fanbox.cc` / `fanbox.cc/@*` → 投稿情報を収集してクリップボードにコピー
- `DownloadManage` クラス・`addByPostInfo`（postInfo → DownloadObject への変換）・
  `convertImageMap` 等は `download-helper/fanbox-collector` から import する共有ロジック
  （投稿一覧取得・ページネーションなど API 呼び出し自体はこのリポジトリ固有の実装として残る）
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

## コーディング規約

- Biome (recommended ルールセット) で強制。設定は `biome.json` に記載
- インデント: スペース2つ
- シングルクォート、セミコロンあり、末尾カンマあり
- `lineWidth: 120`

## Git運用

- リモート `origin`: ValerianDillon/fanbox-downloader
- リモート `upstream`: furubarug/fanbox-downloader（上流の変更取り込み用に維持）
- コミットの author/committer は ValerianDillon であること
- **`gh pr create` は fork 元 (upstream) をデフォルトのベースリポジトリにする。** 必ず `--repo ValerianDillon/fanbox-downloader --base master` を指定すること
