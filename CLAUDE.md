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
- FANBOX API (`api.fanbox.cc`) を fetch で呼び出し、レート制限対策に sleep を挟む
  (429 のバックオフや `Retry-After` の解釈は未実装。Issue #3 を参照)
- 配列レスポンスは `body` 直下ではなく `body.<キー>` に入る。形状が想定と違うとき、
  プラン名とタグは表示の補助なので握りつぶして続行し、投稿一覧と投稿詳細は
  `ApiShapeError` で中止して結果自体を返さない (途中までの結果を成功として出さないため)
- 投稿一覧に本文は含まれないため、閲覧できる投稿はすべて `post.info` を個別に叩く
- 取得できなかった投稿とページは件数を数えて alert で通知する
  (`addByPostInfo` が黙って読み飛ばすため、数えないと全投稿が消えても気付けない)

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
