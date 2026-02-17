# fanbox-downloader

pixiv FANBOX の投稿をZIPとして一括ダウンロードするブックマークレット。
[darekasan/fanbox-downloader](https://github.com/darekasan/fanbox-downloader) → [furubarug](https://github.com/furubarug/fanbox-downloader) → 本リポジトリ の順でforkしたもの。

## コマンド

- `bun run build` — `bun build --minify` で `fanbox-downloader.ts` → `docs/fanbox-downloader.min.js` にバンドル
- `bun run lint` — Biome による静的解析・フォーマット修正
- テストフレームワークはなし

## プロジェクト構成

```
fanbox-downloader.ts    # メインソース（エントリポイント、export main()）
types.d.ts              # FANBOX API の型定義
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

## 技術スタック

- Bun でバンドル + ミニファイ（TypeScript → ESM）
- Biome で静的解析・フォーマット
- tsconfig.json はエディタの型チェック用に維持
- 唯一の runtime 依存: `download-helper`（GitHub の git tag `vX.X.X` から取得）

## アーキテクチャ

- `main()` — ブックマークレットのエントリポイント。URL パターンで動作を分岐
  - `downloads.fanbox.cc` → DownloadHelper UI を起動（download-helper パッケージ）
  - `*.fanbox.cc` / `fanbox.cc/@*` → 投稿情報を収集してクリップボードにコピー
- `DownloadManage` クラス — ダウンロード設定（プラン・タグ・制限数）の管理
- FANBOX API (`api.fanbox.cc`) を fetch で呼び出し、レート制限対策に sleep を挟む

## コーディング規約

- Biome (recommended ルールセット) で強制。設定は `biome.json` に記載
- インデント: スペース2つ
- シングルクォート、セミコロンあり、末尾カンマあり
- `lineWidth: 120`

## Git運用

- リモート `origin`: ValerianDillon/fanbox-downloader
- リモート `upstream`: furubarug/fanbox-downloader（上流の変更取り込み用に維持）
- コミットの author/committer は ValerianDillon であること
