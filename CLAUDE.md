# fanbox-downloader

pixiv FANBOX の投稿をZIPとして一括ダウンロードするブックマークレット。
[darekasan/fanbox-downloader](https://github.com/darekasan/fanbox-downloader) → [furubarug](https://github.com/furubarug/fanbox-downloader) → 本リポジトリ の順でforkしたもの。

## コマンド

- `npm run build` — webpack で `fanbox-downloader.ts` → `docs/fanbox-downloader.min.js` にバンドル
- `npm run lint` — ESLint + Prettier による静的解析・自動修正
- テストフレームワークはなし

## プロジェクト構成

```
fanbox-downloader.ts    # メインソース（エントリポイント、export main()）
types.d.ts              # FANBOX API の型定義
docs/
  fanbox-downloader.min.js  # ビルド成果物（コミット対象）
  index.html                # GitHub Pages ランディングページ
  sitemap.xml
```

- 単一ファイル構成のブックマークレット
- ビルド成果物 `docs/fanbox-downloader.min.js` はgit管理対象。ビルド後に差分があればコミットすること

## 技術スタック

- TypeScript 4.x → ES2017 ターゲット、ES Module 出力
- Webpack 5（production モード）
- 唯一の runtime 依存: `download-helper`（GitHub の git tag `vX.X.X` から取得）

## アーキテクチャ

- `main()` — ブックマークレットのエントリポイント。URL パターンで動作を分岐
  - `downloads.fanbox.cc` → DownloadHelper UI を起動（download-helper パッケージ）
  - `*.fanbox.cc` / `fanbox.cc/@*` → 投稿情報を収集してクリップボードにコピー
- `DownloadManage` クラス — ダウンロード設定（プラン・タグ・制限数）の管理
- FANBOX API (`api.fanbox.cc`) を fetch で呼び出し、レート制限対策に sleep を挟む

## コーディング規約

- ESLint (airbnb-typescript/base) + Prettier で強制。設定は `package.json` 内に記載
- インデント: タブ文字
- シングルクォート、セミコロンあり、末尾カンマあり
- `printWidth: 100`

## Git運用

- リモート `origin`: ValerianDillon/fanbox-downloader
- リモート `upstream`: furubarug/fanbox-downloader（上流の変更取り込み用に維持）
- コミットの author/committer は ValerianDillon であること
