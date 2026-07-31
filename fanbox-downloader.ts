import { DownloadHelper, type DownloadObject } from 'download-helper/download-helper';
import {
  type AddPostResult,
  addByPostInfo,
  DownloadManage,
  type PaginatedPosts,
  type PlanInfo,
  type Plans,
  type PostInfo,
  type PostInfoResponse,
  type PostList,
  type PostListItem,
  type Tags,
} from 'download-helper/fanbox-collector';

// 一覧に本文が載らなくなり投稿ごとに post.info を叩くようになったため、
// 拡張版の既定値と同じ 500ms に揃える (旧 100ms のままではリクエスト密度が倍以上になる)
const API_RATE_LIMIT_MS = 500;

/**
 * 取得できなかった件数。
 * addByPostInfo は取れなかった投稿を黙って読み飛ばすので、数えずに任せると
 * 本文の在り処が変わって全投稿が消えても気付けない。
 * ページ単位の失敗は欠落した投稿数が不明なので、投稿単位とは足し合わせない。
 */
type FailureCounts = { posts: number; pages: number };

/** isIgnoreFree による意図的な除外は数えない。取れなかった投稿だけを数える */
function isFailure(result: AddPostResult): boolean {
  return result === 'unavailable' || result === 'invalid';
}

/**
 * FANBOX API の配列レスポンスは body 直下ではなく body.<キー> に入る。
 * 形状が違えば空配列に落とさず投げる: 空配列にすると「0 件だった」と区別が付かず、
 * 中身のない結果を成功として出してしまう。
 */
class ApiShapeError extends Error {
  constructor(url: string) {
    super(`API レスポンスの形状が想定外: ${url}`);
    this.name = 'ApiShapeError';
  }
}

function unwrapArray<T>(value: unknown, url: string, isValidItem?: (item: unknown) => boolean): T[] {
  if (!Array.isArray(value) || (isValidItem && !value.every(isValidItem))) {
    throw new ApiShapeError(url);
  }
  return value as T[];
}

/**
 * メイン
 */
export async function main() {
  let downloadObject: DownloadObject | undefined;
  if (window.location.origin === 'https://downloads.fanbox.cc') {
    await new DownloadHelper(DownloadManage.utils).createDownloadUI('fanbox-downloader');
    return;
  } else if (window.location.origin === 'https://www.fanbox.cc') {
    const creatorId = window.location.href.match(/fanbox.cc\/@([^/]+)/)?.[1];
    const postId = window.location.href.match(/fanbox.cc\/@.+\/posts\/(\d+)/)?.[1];
    downloadObject = await searchBy(creatorId, postId);
  } else if (window.location.href.match(/^https:\/\/([^./]+)\.fanbox\.cc\//)) {
    const creatorId = window.location.href.match(/^https:\/\/([^./]+)\.fanbox\.cc\//)?.[1];
    const postId = window.location.href.match(/.*\.fanbox\.cc\/posts\/(\d+)/)?.[1];
    downloadObject = await searchBy(creatorId, postId);
  } else {
    alert(`ここどこですか(${window.location.href})`);
    return;
  }
  if (!downloadObject) return;
  const json = downloadObject.stringify();
  console.log(json);
  const jsonCopied = () => {
    alert('jsonをコピーしました。downloads.fanbox.ccで実行して貼り付けてね');
    if (confirm('downloads.fanbox.ccに遷移する？')) {
      document.location.href = 'https://downloads.fanbox.cc';
    }
  };
  try {
    await navigator.clipboard.writeText(json);
    jsonCopied();
  } catch (_) {
    document.body.addEventListener(
      'click',
      () => {
        navigator.clipboard
          .writeText(json)
          .then(() => jsonCopied())
          .catch(() => alert('jsonコピーに失敗しました。もう一度実行するかコンソールからコピーしてね'));
      },
      { once: true },
    );
    alert('jsonコピーに失敗しました。画面の適当なとこをクリック！');
  }
}

/**
 * 投稿情報を取得してまとめて返す
 * レスポンス形状の退行を検出できるよう、テストから直接呼べるように公開している。
 * @param creatorId ユーザーID
 * @param postId 投稿ID
 */
export async function searchBy(
  creatorId: string | undefined,
  postId: string | undefined,
): Promise<DownloadObject | undefined> {
  if (!creatorId) {
    alert('しらないURL');
    return;
  }
  const planUrl = `https://api.fanbox.cc/plan.listCreator?creatorId=${creatorId}`;
  let plans: PlanInfo[] = [];
  try {
    // プラン名は支援額タグの表示名に使うだけなので、失敗しても収集は続ける
    plans = unwrapArray<PlanInfo>(
      DownloadManage.utils.httpGetAs<Plans>(planUrl)?.body?.plans,
      planUrl,
      (item) => typeof (item as PlanInfo | null)?.fee === 'number',
    );
  } catch (e) {
    console.error('プラン情報の取得に失敗:', e);
  }
  const feeMapper = new Map<number, string>();
  for (const plan of plans) {
    feeMapper.set(plan.fee, plan.title);
  }
  const downloadSettings = new DownloadManage(creatorId, feeMapper);
  downloadSettings.downloadObject.setUrl(`https://www.fanbox.cc/@${creatorId}`);
  const tagUrl = `https://api.fanbox.cc/tag.getFeatured?creatorId=${creatorId}`;
  try {
    const definedTags = unwrapArray<{ tag: string }>(
      DownloadManage.utils.httpGetAs<Tags>(tagUrl)?.body?.featuredTags,
      tagUrl,
      (item) => typeof (item as { tag?: unknown } | null)?.tag === 'string',
    ).map((tag) => tag.tag);
    downloadSettings.addTags(...definedTags);
  } catch (e) {
    console.error('タグ情報の取得に失敗:', e);
  }
  let failures: FailureCounts;
  if (postId) {
    failures = { posts: isFailure(addByPostInfo(downloadSettings, getPostInfoById(postId))) ? 1 : 0, pages: 0 };
  } else {
    const collected = await getItemsById(downloadSettings);
    // 形状エラーで中止したときは、途中までの結果を成功として出さない
    if (!collected) return;
    failures = collected;
  }
  downloadSettings.applyTags();
  const messages = [
    failures.posts > 0 ? `${failures.posts} 件の投稿` : '',
    failures.pages > 0 ? `${failures.pages} ページ分の投稿一覧 (投稿数は不明)` : '',
  ].filter(Boolean);
  if (messages.length) {
    alert(`${messages.join(' と ')}を取得できませんでした (支援プランの範囲外か、レート制限の可能性があります)`);
  }
  return downloadSettings.downloadObject;
}

/**
 * ユーザーIDからitemsを得る
 * @param downloadManage ダウンロード設定
 */
async function getItemsById(downloadManage: DownloadManage): Promise<FailureCounts | undefined> {
  downloadManage.isIgnoreFree = confirm('無料コンテンツを省く？');
  const limitBase = prompt('取得制限数を入力 キャンセルで全て取得');
  if (limitBase) {
    const limit = Number.parseInt(limitBase, 10);
    if (limit) {
      downloadManage.setLimitAvailable(true);
      downloadManage.setLimit(limit);
    }
  }
  const paginateUrl = `https://api.fanbox.cc/post.paginateCreator?creatorId=${downloadManage.userId}`;
  let urls: string[];
  try {
    urls = unwrapArray<string>(
      DownloadManage.utils.httpGetAs<PaginatedPosts>(paginateUrl)?.body?.pageUrls,
      paginateUrl,
      (item) => typeof item === 'string',
    );
  } catch (e) {
    console.error('投稿一覧の取得に失敗:', e);
    alert('投稿一覧の取得に失敗しました');
    return undefined;
  }
  const failures: FailureCounts = { posts: 0, pages: 0 };
  for (let i = 0; i < urls.length; i++) {
    console.log(`${i + 1}回目`);
    try {
      failures.posts += await addByPostListUrl(downloadManage, urls[i]);
    } catch (e) {
      // 形状の不一致は「このページだけ落ちた」ではなく API 仕様変更なので、
      // 読み飛ばすと中身のない結果を成功として出してしまう
      if (e instanceof ApiShapeError) {
        console.error('投稿一覧の形状が想定外:', e);
        alert('FANBOX API の仕様が変わった可能性があります。取得を中止しました');
        return undefined;
      }
      // 1 ページには複数の投稿が載るため、欠落数は不明
      console.error(`${i + 1}回目の投稿リスト取得に失敗:`, e);
      failures.pages++;
    }
    await DownloadManage.utils.sleep(API_RATE_LIMIT_MS);
  }
  return failures;
}

/**
 * 投稿リストURLからURLリストに追加
 * @param downloadManage ダウンロード設定
 * @param url
 */
async function addByPostListUrl(downloadManage: DownloadManage, url: string): Promise<number> {
  const postList = unwrapArray<PostListItem>(
    DownloadManage.utils.httpGetAs<PostList>(url)?.body?.posts,
    url,
    (item) => {
      const post = item as PostListItem | null;
      return !!post && typeof post.id === 'string' && typeof post.isRestricted === 'boolean';
    },
  );
  console.log(`投稿の数:${postList.length}`);
  let failedPostCount = 0;
  for (const post of postList) {
    if (!downloadManage.isLimitValid()) break;
    // 閲覧できない投稿も結果からは欠落するので数える。数えないと、一覧が全件
    // isRestricted になったときに空の結果を「失敗 0 件」として出してしまう。
    if (post.isRestricted) {
      if (!(downloadManage.isIgnoreFree && post.feeRequired === 0)) failedPostCount++;
      continue;
    }
    // 一覧レスポンスに本文は含まれないため、投稿ごとに post.info を叩く必要がある
    await DownloadManage.utils.sleep(API_RATE_LIMIT_MS);
    if (isFailure(addByPostInfo(downloadManage, getPostInfoById(post.id)))) failedPostCount++;
  }
  return failedPostCount;
}

/**
 * 投稿IDからpostInfoを得る
 * @param postId 投稿ID
 */
function getPostInfoById(postId: string): PostInfo | undefined {
  const url = `https://api.fanbox.cc/post.info?postId=${postId}`;
  try {
    const post = DownloadManage.utils.httpGetAs<PostInfoResponse>(url)?.body?.post;
    // 閲覧できない投稿は HTTP 4xx で返るため、形の違いは「取れなかった投稿」ではなく仕様変更とみなす。
    // undefined に丸めると、全投稿を「支援額不足」と誤報して空の結果を出してしまう。
    if (
      !post ||
      typeof post.id !== 'string' ||
      typeof post.type !== 'string' ||
      typeof post.isRestricted !== 'boolean'
    ) {
      throw new ApiShapeError(url);
    }
    return post;
  } catch (e) {
    if (e instanceof ApiShapeError) throw e;
    console.error(`投稿情報の取得に失敗 (postId: ${postId}):`, e);
    return undefined;
  }
}
