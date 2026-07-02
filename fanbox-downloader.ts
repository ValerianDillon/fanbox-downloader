import { DownloadHelper, type DownloadObject } from 'download-helper/download-helper';
import { addByPostInfo, DownloadManage, type Plans, type PostInfo, type Tags } from 'download-helper/fanbox-collector';

const API_RATE_LIMIT_MS = 100;

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
 * @param creatorId ユーザーID
 * @param postId 投稿ID
 */
async function searchBy(
  creatorId: string | undefined,
  postId: string | undefined,
): Promise<DownloadObject | undefined> {
  if (!creatorId) {
    alert('しらないURL');
    return;
  }
  let plans: Plans['body'];
  try {
    plans = DownloadManage.utils.httpGetAs<Plans>(`https://api.fanbox.cc/plan.listCreator?creatorId=${creatorId}`).body;
  } catch (e) {
    console.error('プラン情報の取得に失敗:', e);
    plans = undefined;
  }
  const feeMapper = new Map<number, string>();
  if (plans) {
    for (const plan of plans) {
      feeMapper.set(plan.fee, plan.title);
    }
  }
  const downloadSettings = new DownloadManage(creatorId, feeMapper);
  downloadSettings.downloadObject.setUrl(`https://www.fanbox.cc/@${creatorId}`);
  try {
    const definedTags =
      DownloadManage.utils
        .httpGetAs<Tags>(`https://api.fanbox.cc/tag.getFeatured?creatorId=${creatorId}`)
        .body?.map((tag) => tag.tag) ?? [];
    downloadSettings.addTags(...definedTags);
  } catch (e) {
    console.error('タグ情報の取得に失敗:', e);
  }
  if (postId) addByPostInfo(downloadSettings, getPostInfoById(postId));
  else await getItemsById(downloadSettings);
  downloadSettings.applyTags();
  return downloadSettings.downloadObject;
}

/**
 * ユーザーIDからitemsを得る
 * @param downloadManage ダウンロード設定
 */
async function getItemsById(downloadManage: DownloadManage) {
  downloadManage.isIgnoreFree = confirm('無料コンテンツを省く？');
  const limitBase = prompt('取得制限数を入力 キャンセルで全て取得');
  if (limitBase) {
    const limit = Number.parseInt(limitBase, 10);
    if (limit) {
      downloadManage.setLimitAvailable(true);
      downloadManage.setLimit(limit);
    }
  }
  let urls: string[];
  try {
    urls = DownloadManage.utils.httpGetAs<{ body: string[] }>(
      `https://api.fanbox.cc/post.paginateCreator?creatorId=${downloadManage.userId}`,
    ).body;
  } catch (e) {
    console.error('投稿一覧の取得に失敗:', e);
    alert('投稿一覧の取得に失敗しました');
    return;
  }
  for (let i = 0; i < urls.length; i++) {
    console.log(`${i + 1}回目`);
    try {
      await addByPostListUrl(downloadManage, urls[i]);
    } catch (e) {
      console.error(`${i + 1}回目の投稿リスト取得に失敗:`, e);
    }
    await DownloadManage.utils.sleep(API_RATE_LIMIT_MS);
  }
}

/**
 * 投稿リストURLからURLリストに追加
 * @param downloadManage ダウンロード設定
 * @param url
 */
async function addByPostListUrl(downloadManage: DownloadManage, url: string): Promise<void> {
  const postList = DownloadManage.utils.httpGetAs<{ body: PostInfo[] }>(url).body;
  console.log(`投稿の数:${postList.length}`);
  for (const post of postList) {
    if (downloadManage.isLimitValid()) {
      if (post.body) {
        addByPostInfo(downloadManage, post);
      } else if (!post.isRestricted) {
        await DownloadManage.utils.sleep(API_RATE_LIMIT_MS);
        addByPostInfo(downloadManage, getPostInfoById(post.id));
      }
    } else break;
  }
}

/**
 * 投稿IDからpostInfoを得る
 * @param postId 投稿ID
 */
function getPostInfoById(postId: string): PostInfo | undefined {
  try {
    return DownloadManage.utils.httpGetAs<{ body?: PostInfo }>(`https://api.fanbox.cc/post.info?postId=${postId}`).body;
  } catch (e) {
    console.error(`投稿情報の取得に失敗 (postId: ${postId}):`, e);
    return undefined;
  }
}
