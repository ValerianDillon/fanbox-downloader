import {
  ApiSession,
  HttpError,
  RateLimitExhaustedError,
  ResponseParseError,
  type Transport,
  TransportExhaustedError,
} from 'download-helper/api-session';
import { DownloadHelper, type DownloadObject } from 'download-helper/download-helper';
import {
  type AddPostResult,
  addByPostInfo,
  DownloadManage,
  type PlanInfo,
  type PlansResponse,
  type PostInfoCandidate,
  type PostInfoResponse,
  type PostListItemCandidate,
  type PostListResponse,
  type PostPaginationResponse,
  type TagsResponse,
} from 'download-helper/fanbox-collector';

// 一覧に本文が載らなくなり投稿ごとに post.info を叩くようになったため、
// 拡張版の既定値と同じ 500ms に揃える (旧 100ms のままではリクエスト密度が倍以上になる)
const API_RATE_LIMIT_MS = 500;

/**
 * 取得できなかった件数の内訳。
 * addByPostInfo は取れなかった投稿を黙って読み飛ばすので、数えずに任せると
 * 本文の在り処が変わって全投稿が消えても気付けない。
 * 理由ごとに利用者が取るべき対応が違うため 1 個の数値に合算しない。
 * とくにページ単位の失敗は欠落した投稿数が不明なので、投稿単位とは足し合わせられない。
 */
type FailureCounts = {
  /** 閲覧できないため本文を取り込めなかった投稿。支援プランの範囲外など正常系でも起こる */
  restricted: number;
  /**
   * 本文が無かった投稿と、投稿詳細が HTTP エラーだった投稿。
   * 通信の失敗と CORS は再試行を経て枯渇として伝播するので、ここには合流しない
   */
  missingBody: number;
  /** 未知の投稿タイプで取り込めなかった投稿 */
  unsupported: number;
  /** 取得できなかった投稿一覧ページ */
  pages: number;
};

/** 収集を最後まで走査せずに打ち切った理由。部分結果は捨てず不完全と明示して返す */
type StoppedReason = 'rate-limit-exhausted' | 'transport-exhausted';

/** 打ち切ったときに利用者へ示す情報。何件まで取れてどこで止まったかが分からないと確認できない */
type StoppedInfo = { reason: StoppedReason; addedPostCount: number; page?: number };

type CollectOutcome = { failures: FailureCounts; stopped?: StoppedInfo };

/** 再試行枠を使い切った失敗か。使い切った時点で次の要求を出さない */
function exhaustionReason(error: unknown): StoppedReason | undefined {
  if (error instanceof RateLimitExhaustedError) return 'rate-limit-exhausted';
  if (error instanceof TransportExhaustedError) return 'transport-exhausted';
  return undefined;
}

function emptyFailureCounts(): FailureCounts {
  return { restricted: 0, missingBody: 0, unsupported: 0, pages: 0 };
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

/**
 * 既知の投稿タイプなのに addByPostInfo が実際に読むフィールドが欠けていた。
 * 検出層が ApiShapeError (API ラッパーの形状) と違うので型を分けるが、
 * 「このバージョンでは仕様変更に追随できていない」という意味は同じなので中断の扱いは揃える。
 * ApiShapeError を継承しない: instanceof で検出層の違いが潰れるうえ、URL を受け取る
 * コンストラクタの契約に合わない。
 */
class PostBodyInvalidError extends Error {
  constructor(postId: string, type: string, missing: readonly string[]) {
    super(`投稿本文の形状が想定外 (postId: ${postId}, type: ${type}, missing: ${missing.join(', ')})`);
    this.name = 'PostBodyInvalidError';
  }
}

const ABORT_MESSAGE = 'FANBOX API の仕様が変わった可能性があります。取得を中止しました';
const UNEXPECTED_ABORT_MESSAGE = '予期しないエラーが発生したため取得を中止しました (詳細はコンソール)';

/**
 * 投稿単位の失敗に丸めず、結果自体を返さずに中断すべきエラーか。
 * ResponseParseError (応答を JSON として読めない) も、通信の問題ではなく仕様変更の兆候
 * なので同じ扱いにする。
 */
function isCollectionAbortError(error: unknown): error is ApiShapeError | PostBodyInvalidError | ResponseParseError {
  return error instanceof ApiShapeError || error instanceof PostBodyInvalidError || error instanceof ResponseParseError;
}

/**
 * 収集を中止して結果を返さないことを通知する。
 * 想定外の例外も投稿単位・ページ単位の失敗に丸めず中止する: どこまで取り込めたか分からない
 * 状態で結果を出すと、欠けた ZIP を成功として渡してしまう。
 */
function abortCollection(error: unknown): undefined {
  if (isCollectionAbortError(error)) {
    console.error('取得を中止:', error);
    alert(ABORT_MESSAGE);
  } else {
    console.error('予期しないエラーで取得を中止:', error);
    alert(UNEXPECTED_ABORT_MESSAGE);
  }
  return undefined;
}

/**
 * addByPostInfo の結果を counts に反映する。
 * invalid だけは投稿単位の失敗に数えず投げる: 既知の投稿タイプなのに読むべきフィールドが
 * 欠けている構造的な不一致であり、支援額不足のような正常系では説明できない。数えて続行すると
 * 仕様変更に気付かないまま中身の欠けた結果を成功として出してしまう。
 */
function applyAddResult(result: AddPostResult, counts: FailureCounts): boolean {
  switch (result.status) {
    case 'added':
      return true;
    case 'ignored':
      return false;
    case 'unavailable':
      switch (result.reason) {
        case 'restricted':
          counts.restricted++;
          return false;
        case 'missing-body':
          // 本文が無かった投稿と、詳細取得が HTTP エラーだった投稿が合流する。
          // 通信の失敗と CORS は再試行を経て枯渇として伝播するので、ここには来ない
          counts.missingBody++;
          return false;
        default: {
          // reason が増えたときに型検査で気付けるようにする
          const exhaustiveReason: never = result.reason;
          throw new Error(`未知の unavailable reason: ${JSON.stringify(exhaustiveReason)}`);
        }
      }
    case 'unsupported':
      counts.unsupported++;
      return false;
    case 'invalid':
      throw new PostBodyInvalidError(result.postId, result.type, result.missing);
    default: {
      // status が増えたときに型検査で気付けるようにする
      const exhaustive: never = result;
      throw new Error(`未知の AddPostResult: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 打ち切りの通知。原因と、どこまで取れてどこで止まったかを示す */
function buildStoppedNotice(stopped: StoppedInfo): string {
  const cause =
    stopped.reason === 'rate-limit-exhausted'
      ? 'レート制限のため途中で打ち切りました。'
      : '通信に失敗したため途中で打ち切りました。';
  const where = stopped.page === undefined ? '' : ` (${stopped.page} ページ目で停止)`;
  // 0 件なら部分結果と呼べるものが無い。「不完全な結果」と言うと、出力があるかのように読める
  if (stopped.addedPostCount === 0) return `${cause}${where}\n取り込めた投稿が無いため、結果は出力しません。`;
  return `${cause}\nここまでに取り込めた投稿: ${stopped.addedPostCount} 件${where}\n以降は取得していないため、不完全な結果です。`;
}

/**
 * 失敗件数から alert の文面を組み立てる。失敗が無ければ undefined を返す。
 * 原因は推測しない: missing-body には CORS・通信断・API 障害・レート制限・仕様変更・実際の
 * 本文欠落が合流しており、件数の比率からは識別できないため、断定すると誤誘導になる。
 * 確認が必要な区分を先に置き、正常系でも大量に出る restricted に埋もれないようにする。
 */
export function buildFailureMessage(failures: FailureCounts, stoppedInfo?: StoppedInfo): string | undefined {
  const stopped = stoppedInfo ? buildStoppedNotice(stoppedInfo) : '';
  const needsAttention = [
    failures.missingBody > 0
      ? `- 投稿詳細を取得できないか、本文を利用できなかった投稿: ${failures.missingBody} 件`
      : '',
    failures.unsupported > 0 ? `- 未対応の投稿形式: ${failures.unsupported} 件` : '',
    failures.pages > 0 ? `- 取得できなかった投稿一覧: ${failures.pages} ページ (欠落した投稿数は不明)` : '',
  ].filter(Boolean);
  if (needsAttention.length === 0) {
    if (failures.restricted === 0) return stopped || undefined;
    // 閲覧制限だけなら異常ではないので、見出しを付けずに 1 行で伝える
    const line = `閲覧制限により取得できなかった投稿: ${failures.restricted} 件`;
    return stopped ? `${stopped}\n\n${line}` : line;
  }
  const sections = [`確認が必要な未取得:\n${needsAttention.join('\n')}`];
  if (failures.restricted > 0) {
    sections.push(`閲覧条件による未取得:\n- 閲覧制限のある投稿: ${failures.restricted} 件`);
  }
  const body = `一部の投稿を取得できませんでした。\n\n${sections.join('\n\n')}`;
  return stopped ? `${stopped}\n\n${body}` : body;
}

function unwrapArray<T>(value: unknown, url: string, isValidItem?: (item: unknown) => boolean): T[] {
  if (!Array.isArray(value) || (isValidItem && !value.every(isValidItem))) {
    throw new ApiShapeError(url);
  }
  return value as T[];
}

/**
 * ページ origin から同期 XHR で取得する transport。
 * 読めるヘッダは CORS セーフリストに限られるため Retry-After は通常 null になる。
 * それでも読みに行くのは、サーバが Access-Control-Expose-Headers を返すようになれば
 * 実装を変えずに使えるようにするため。
 */
export const pageOriginTransport: Transport = async (url, _signal) => {
  // 同期 XHR は発行後に中断できない。中断の検出はセッション側が発行の前後で行う
  const xhr = new XMLHttpRequest();
  // open() は URL の構文エラーで SyntaxError を投げる。これは通信の失敗ではなく
  // 仕様変更や実装上のバグなので、通信障害に丸めず呼び出し側へ渡す
  xhr.open('GET', url, false);
  xhr.withCredentials = true;
  try {
    xhr.send(null);
  } catch (cause) {
    // 同期 XHR の通信失敗は NetworkError として規定されている。DOMException でも
    // InvalidStateError などは状態違反であって通信障害ではないので丸めない
    if (!(cause instanceof DOMException) || cause.name !== 'NetworkError') throw cause;
    // 応答を観測できていないので status は推測しない
    return { kind: 'unobservable-failure', cause };
  }
  // 同期 XHR は通信断で例外を投げるが、status 0 で返る経路もある
  if (xhr.status === 0) return { kind: 'unobservable-failure' };
  return {
    kind: 'response',
    status: xhr.status,
    body: xhr.responseText,
    retryAfter: xhr.getResponseHeader('Retry-After'),
  };
};

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
  // レート制御の状態は収集ごとに持つ。前回の収集で引き上がった間隔を次へ持ち越さない。
  // 差し替え可能にしているのは、契約テストから transport を注入するため
  session: ApiSession = new ApiSession(API_RATE_LIMIT_MS, pageOriginTransport),
): Promise<DownloadObject | undefined> {
  if (!creatorId) {
    alert('しらないURL');
    return;
  }
  const planUrl = `https://api.fanbox.cc/plan.listCreator?creatorId=${creatorId}`;
  let plans: PlanInfo[] = [];
  try {
    // プラン名は支援額タグの表示名に使うだけなので、失敗しても収集は続ける
    plans = await session.fetchJson<PlansResponse, PlanInfo[]>(planUrl, (json) =>
      unwrapArray<PlanInfo>(json?.body?.plans, planUrl, (item) => typeof (item as PlanInfo | null)?.fee === 'number'),
    );
  } catch (e) {
    // 枯渇だけは握りつぶさない。既に上限まで待った直後に別のエンドポイントへ要求を出すのは、
    // 再試行上限を別経路で実質的に延長することになる
    const reason = exhaustionReason(e);
    if (reason) {
      console.error('プラン情報の取得を中止:', e);
      alert(buildFailureMessage(emptyFailureCounts(), { reason, addedPostCount: 0 }));
      return;
    }
    // 表示の補助として想定しているのは HTTP エラーと、応答を読めなかった/形状が違った場合だけ。
    // plan / tag はここでだけ ResponseParseError を握りつぶす: 表示の補助しか担っておらず、
    // 続行しても ZIP の中身は欠けない (投稿一覧・投稿詳細では同じ型で収集を止める)。
    // 想定外の例外は実装上のバグでありうるので、続行せず中止する
    if (!(e instanceof HttpError || e instanceof ApiShapeError || e instanceof ResponseParseError)) {
      return abortCollection(e);
    }
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
    const definedTags = await session.fetchJson<TagsResponse, string[]>(tagUrl, (json) =>
      unwrapArray<{ tag: string }>(
        json?.body?.featuredTags,
        tagUrl,
        (item) => typeof (item as { tag?: unknown } | null)?.tag === 'string',
      ).map((tag) => tag.tag),
    );
    downloadSettings.addTags(...definedTags);
  } catch (e) {
    const reason = exhaustionReason(e);
    if (reason) {
      console.error('タグ情報の取得を中止:', e);
      alert(buildFailureMessage(emptyFailureCounts(), { reason, addedPostCount: 0 }));
      return;
    }
    // plan と同じ理由・同じ方針 (上の catch のコメント参照)
    if (!(e instanceof HttpError || e instanceof ApiShapeError || e instanceof ResponseParseError)) {
      return abortCollection(e);
    }
    console.error('タグ情報の取得に失敗:', e);
  }
  let outcome: CollectOutcome;
  if (postId) {
    const failures = emptyFailureCounts();
    try {
      applyAddResult(addByPostInfo(downloadSettings, await getPostInfoById(session, postId)), failures);
    } catch (e) {
      // 単一投稿では部分結果というものが無いので、枯渇でも結果を返さない
      const reason = exhaustionReason(e);
      if (reason) {
        console.error('取得を中止:', e);
        alert(buildFailureMessage(failures, { reason, addedPostCount: 0 }));
        return;
      }
      // 一覧モードと同じく、中止すべき失敗は投稿単位の失敗に丸めず結果自体を返さない
      return abortCollection(e);
    }
    outcome = { failures };
  } else {
    const collected = await getItemsById(session, downloadSettings);
    // 形状エラーで中止したときは、途中までの結果を成功として出さない
    if (!collected) return;
    // 1 件も取り込めていない打ち切りは、plan / tag / paginate / 単一投稿での枯渇と扱いを揃えて
    // 結果を返さない。同じ「0 件かつ枯渇」で保存されたりされなかったりするのを避ける
    if (collected.stopped?.addedPostCount === 0) {
      alert(buildFailureMessage(collected.failures, collected.stopped));
      return;
    }
    outcome = collected;
  }
  downloadSettings.applyTags();
  const message = buildFailureMessage(outcome.failures, outcome.stopped);
  if (message) alert(message);
  return downloadSettings.downloadObject;
}

/**
 * ユーザーIDからitemsを得る
 * @param downloadManage ダウンロード設定
 */
async function getItemsById(session: ApiSession, downloadManage: DownloadManage): Promise<CollectOutcome | undefined> {
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
    urls = await session.fetchJson<PostPaginationResponse, string[]>(paginateUrl, (json) =>
      unwrapArray<string>(json?.body?.pageUrls, paginateUrl, (item) => typeof item === 'string'),
    );
  } catch (e) {
    // 形状の不一致はページ取得の失敗ではなく仕様変更なので、他の経路と同じ文言で中止する
    if (isCollectionAbortError(e)) return abortCollection(e);
    // 1 件も集まっていないので、枯渇でも部分結果として返すものが無い
    const reason = exhaustionReason(e);
    if (reason) {
      console.error('投稿一覧の取得を中止:', e);
      alert(buildFailureMessage(emptyFailureCounts(), { reason, addedPostCount: 0 }));
      return undefined;
    }
    // 「取得に失敗した」で片付けてよいのは HTTP エラーだけ
    if (!(e instanceof HttpError)) return abortCollection(e);
    console.error('投稿一覧の取得に失敗:', e);
    alert('投稿一覧の取得に失敗しました');
    return undefined;
  }
  const failures = emptyFailureCounts();
  // 打ち切ったときに「何件まで取れたか」を示すため、途中経過を共有の入れ物で持つ
  const progress = { addedPostCount: 0 };
  for (let i = 0; i < urls.length; i++) {
    // 取得上限に達したら一覧ページも要求しない。要求された範囲は完了しているので、
    // ここで止めるのは打ち切りではない (残りを叩き続けると無駄な負荷になるうえ、
    // そこで枯渇すると完了しているのに「不完全」と誤って伝えることになる)
    if (!downloadManage.isLimitValid()) break;
    console.log(`${i + 1}回目`);
    try {
      // ページ単位の失敗として数えてよいのは一覧の取得・検証で出た例外だけなので、
      // 投稿単位の処理とは try を分ける。まとめて囲むと投稿側の想定外の例外まで
      // 「ページが 1 枚落ちた」ことにされ、原因の分類を誤る。
      const postList = await fetchPostList(session, urls[i], i, failures);
      if (postList) await addPostList(session, downloadManage, postList, failures, progress);
    } catch (e) {
      // 再試行枠を使い切ったら次のページへ進まない。オフラインなら待ち続ける利益が小さく、
      // 非可視の 429 だった場合に残りを要求し続けるのは危険。
      // ただし集めた分は捨てず、不完全と明示して返す。
      const reason = exhaustionReason(e);
      if (reason) {
        console.error('収集を打ち切り:', e);
        return { failures, stopped: { reason, addedPostCount: progress.addedPostCount, page: i + 1 } };
      }
      return abortCollection(e);
    }
  }
  return { failures };
}

/**
 * 投稿一覧ページを取得して検証する。取得できなければページ単位の失敗として数え undefined を返す。
 * 形状の不一致だけは仕様変更なので、中止させるために呼び出し側へ投げる。
 * @param url 投稿一覧ページのURL
 * @param index 何ページ目か (ログ用の 0 始まり)
 * @param failures 取得できなかった件数の内訳。呼び出し側と共有して加算する
 */
async function fetchPostList(
  session: ApiSession,
  url: string,
  index: number,
  failures: FailureCounts,
): Promise<PostListItemCandidate[] | undefined> {
  try {
    return await session.fetchJson<PostListResponse, PostListItemCandidate[]>(url, (json) =>
      unwrapArray<PostListItemCandidate>(json?.body?.posts, url, (item) => {
        const post = item as PostListItemCandidate | null;
        // feeRequired は isIgnoreFree の判断に使うので、欠けていれば形状の不一致として扱う
        return (
          !!post &&
          typeof post.id === 'string' &&
          typeof post.isRestricted === 'boolean' &&
          typeof post.feeRequired === 'number'
        );
      }),
    );
  } catch (e) {
    // ページ単位の失敗として数えてよいのは HTTP エラーだけ。枯渇はこのページだけの
    // 失敗ではなく、想定外の例外は実装上のバグでありうるので、どちらも呼び出し側へ渡す。
    // 丸めると原因の分類を誤ったまま収集を続けてしまう。
    if (!(e instanceof HttpError)) throw e;
    // 1 ページには複数の投稿が載るため、欠落数は不明
    console.error(`${index + 1}回目の投稿リスト取得に失敗:`, e);
    failures.pages++;
    return undefined;
  }
}

/**
 * 投稿一覧の各投稿をURLリストに追加
 * @param downloadManage ダウンロード設定
 * @param postList 投稿一覧
 * @param failures 取得できなかった件数の内訳。呼び出し側と共有して加算する
 */
async function addPostList(
  session: ApiSession,
  downloadManage: DownloadManage,
  postList: PostListItemCandidate[],
  failures: FailureCounts,
  progress: { addedPostCount: number },
): Promise<void> {
  console.log(`投稿の数:${postList.length}`);
  for (const post of postList) {
    if (!downloadManage.isLimitValid()) break;
    // 利用者が対象外にした投稿は失敗ではないので、詳細も叩かず数えもしない。
    // addByPostInfo に任せると、詳細の取得が失敗したときに feeRequired が伝わらず
    // missing-body として数えてしまう。
    if (downloadManage.isIgnoreFree && post.feeRequired === 0) continue;
    // 閲覧できない投稿は本文を取り込めないことが一覧の時点で確定しているので、post.info を
    // 叩かずに数える (投稿ごとに 1 リクエスト削減できる)。数えないと、一覧が全件
    // isRestricted になったときに空の結果を「失敗 0 件」として出してしまう。
    if (post.isRestricted) {
      failures.restricted++;
      continue;
    }
    // 一覧レスポンスに本文は含まれないため、投稿ごとに post.info を叩く必要がある
    // (発行間隔はセッションのゲートが担うので、ここで待たない)
    if (applyAddResult(addByPostInfo(downloadManage, await getPostInfoById(session, post.id)), failures)) {
      progress.addedPostCount++;
    }
  }
}

/**
 * 投稿IDからpostInfoを得る
 * @param postId 投稿ID
 */
async function getPostInfoById(session: ApiSession, postId: string): Promise<PostInfoCandidate | undefined> {
  const url = `https://api.fanbox.cc/post.info?postId=${postId}`;
  try {
    return await session.fetchJson<PostInfoResponse, PostInfoCandidate>(url, (json) => {
      const post = json?.body?.post as Record<string, unknown> | null | undefined;
      // 形の違いは「取れなかった投稿」ではなく仕様変更とみなす。undefined に丸めると、
      // 全投稿を「支援額不足」と誤報して空の結果を出してしまう。
      // なお閲覧できない投稿も HTTP 200 で投稿オブジェクトを返し、body プロパティは存在したまま
      // 値が null になる (isRestricted / type / coverImageUrl は通常どおり入る)。本文の欠落は
      // addByPostInfo が検出して投稿単位でスキップする。
      if (
        !post ||
        typeof post.id !== 'string' ||
        typeof post.type !== 'string' ||
        typeof post.isRestricted !== 'boolean'
      ) {
        throw new ApiShapeError(url);
      }
      // 検証した 3 つだけを保証する型で返す。本文の検証は addByPostInfo の入口が行う
      return post as unknown as PostInfoCandidate;
    });
  } catch (e) {
    // 投稿単位の失敗として数えてよいのは HTTP エラーだけ。形状の不一致と枯渇はこの投稿だけの
    // 問題ではなく、想定外の例外は実装上のバグでありうるので、どちらも呼び出し側へ渡す
    if (!(e instanceof HttpError)) throw e;
    console.error(`投稿情報の取得に失敗 (postId: ${postId}):`, e);
    return undefined;
  }
}
