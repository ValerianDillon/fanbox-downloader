# fanbox-downloader

pixiv FANBOXの投稿を投稿毎にフォルダ分け、ZIPとして一括ダウンロードするブックマークレット。

[darekasan/fanbox-downloader](https://github.com/darekasan/fanbox-downloader) を元に
[furubarug](https://github.com/furubarug/fanbox-downloader) がforkしたものを、
さらにforkして独自に改変しています。

### 使い方

https://ValerianDillon.github.io/fanbox-downloader/

ブックマークレット:
```
javascript:import("https://ValerianDillon.github.io/fanbox-downloader/fanbox-downloader.min.js").then(m=>m.main()).catch(e=>alert(`エラー出た(${e})`));
```

### 機能

- FANBOXクリエイターページまたは投稿ページから投稿データを収集
- 投稿を個別フォルダに整理してZIPファイルとしてダウンロード
- 対応コンテンツ: 画像、ファイル、記事(複合コンテンツ)、テキスト
- 投稿のメタデータ(タイトル、日付、プラン、タグ、いいね数等)をJSON/テキストで保存
- ZIP内の各ファイル・フォルダのタイムスタンプ(mtime)に投稿の公開日時を設定
- 投稿ごとのHTMLページ生成 (メディア埋め込み)
- ルートindex.htmlでVue.jsによるタグフィルタリング
- リトライ付きダウンロード、レート制限対策

### 既知の問題

- 4GB超えるとZIP解凍時にエラーが出る(解凍ファイルに問題はないが、ツールによっては解凍不可)
- ファイル表示のリンクで `download` 属性が機能しない(ファイル名重複時に元ファイル名に戻せない)

### 開発

```bash
npm run build
```
