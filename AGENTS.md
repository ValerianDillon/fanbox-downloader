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

## 設計の背景をどこに書くか

「なぜその形にしたか」は共有ruleである `.claude/rules/collector.md` に置き、ここには重複させない。
Claude Codeは `fanbox-downloader.ts` を読むとこのpath-scoped ruleを自動読込する。
Codexは `fanbox-downloader.ts` または `fanbox-downloader.test.ts` を編集する前に、このruleを読んで従う。

## コーディング規約

Biome (recommended ルールセット) で強制。設定は `biome.json` が SoT。

## Git 運用

- **`upstream` remote は置かない。** fork だが上流の変更を取り込む予定はない
  - `upstream` があると `gh` の既定リポジトリが fork 元へ解決され、`gh issue list` / `gh issue view` が他人のリポジトリの Issue を返す。書き込みの誤爆につながる
  - 必要になったときも remote は足さず URL 直指定で fetch する
  - 併せて `gh repo set-default ValerianDillon/fanbox-downloader` を設定してある。クローンし直したら再設定する
- 既定ブランチは `master`。`gh pr create` の `--base` は省略してよい (`--base main` は download-helper 側の慣習で、ここでは失敗する)
- マージは squash。`master` の履歴は `<タイトル> (#21)` の形の単一コミットで揃える
