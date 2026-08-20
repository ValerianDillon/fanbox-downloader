import { afterEach, describe, expect, test } from 'bun:test';
import {
  type Block,
  convertEmbedMap,
  convertFileMap,
  convertImageMap,
  convertUrlEmbedMap,
  DownloadManage,
  type EmbedInfo,
  type FileInfo,
  type ImageInfo,
  type UrlEmbedInfo,
} from 'download-helper/fanbox-collector';
import { buildFailureMessage, searchBy } from './fanbox-downloader';

// convert*Map / DownloadManage の実装本体は download-helper/fanbox-collector.ts に移設済み
// (詳細なテストは download-helper リポジトリの fanbox-collector.test.ts を参照)。
// ここでは依存パッケージとして正しく import・動作できることを結合テストとして確認する。

describe('convertImageMap', () => {
  test('blocks 順にソートされる', () => {
    const imageMap: Record<string, ImageInfo> = {
      img1: { originalUrl: 'url1', extension: 'jpg' },
      img2: { originalUrl: 'url2', extension: 'png' },
      img3: { originalUrl: 'url3', extension: 'gif' },
    };
    const blocks: Block[] = [
      { type: 'image', imageId: 'img3' },
      { type: 'image', imageId: 'img1' },
      { type: 'image', imageId: 'img2' },
    ];
    const result = convertImageMap(imageMap, blocks);
    expect(result).toEqual([
      { originalUrl: 'url3', extension: 'gif' },
      { originalUrl: 'url1', extension: 'jpg' },
      { originalUrl: 'url2', extension: 'png' },
    ]);
  });

  test('blocks に存在しないキーは末尾に配置される', () => {
    const imageMap: Record<string, ImageInfo> = {
      img1: { originalUrl: 'url1', extension: 'jpg' },
      imgX: { originalUrl: 'urlX', extension: 'webp' },
      img2: { originalUrl: 'url2', extension: 'png' },
    };
    const blocks: Block[] = [
      { type: 'image', imageId: 'img2' },
      { type: 'image', imageId: 'img1' },
    ];
    const result = convertImageMap(imageMap, blocks);
    expect(result[0]).toEqual({ originalUrl: 'url2', extension: 'png' });
    expect(result[1]).toEqual({ originalUrl: 'url1', extension: 'jpg' });
    expect(result[2]).toEqual({ originalUrl: 'urlX', extension: 'webp' });
  });
});

describe('convertFileMap', () => {
  test('blocks 順にソートされる', () => {
    const fileMap: Record<string, FileInfo> = {
      f1: { url: 'url1', name: 'a', extension: 'txt' },
      f2: { url: 'url2', name: 'b', extension: 'pdf' },
    };
    const blocks: Block[] = [
      { type: 'file', fileId: 'f2' },
      { type: 'file', fileId: 'f1' },
    ];
    const result = convertFileMap(fileMap, blocks);
    expect(result[0].name).toBe('b');
    expect(result[1].name).toBe('a');
  });
});

describe('convertEmbedMap', () => {
  test('blocks 順にソートされる', () => {
    const embedMap: Record<string, EmbedInfo> = {
      e1: { id: '1' },
      e2: { id: '2' },
    };
    const blocks: Block[] = [
      { type: 'embed', embedId: 'e2' },
      { type: 'embed', embedId: 'e1' },
    ];
    const result = convertEmbedMap(embedMap, blocks);
    expect(result[0]).toEqual({ id: '2' });
    expect(result[1]).toEqual({ id: '1' });
  });
});

describe('convertUrlEmbedMap', () => {
  test('blocks 順にソートされる', () => {
    const urlEmbedMap: Record<string, UrlEmbedInfo> = {
      ue1: { id: 'ue1', type: 'default', url: 'http://a', host: 'a.com' },
      ue2: { id: 'ue2', type: 'default', url: 'http://b', host: 'b.com' },
    };
    const blocks: Block[] = [
      { type: 'url_embed', urlEmbedId: 'ue2' },
      { type: 'url_embed', urlEmbedId: 'ue1' },
    ];
    const result = convertUrlEmbedMap(urlEmbedMap, blocks);
    expect(result[0].id).toBe('ue2');
    expect(result[1].id).toBe('ue1');
  });
});

describe('DownloadManage', () => {
  const createManage = () => new DownloadManage('testUser', new Map([[100, '100円プラン']]));

  describe('getTagByFee', () => {
    test('feeMap に存在する fee → マップの値', () => {
      const m = createManage();
      expect(m.getTagByFee(100)).toBe('100円プラン');
    });

    test('feeMap に存在しない正の fee → "N円プラン"', () => {
      const m = createManage();
      expect(m.getTagByFee(500)).toBe('500円プラン');
    });

    test('fee が 0 → "無料プラン"', () => {
      const m = createManage();
      expect(m.getTagByFee(0)).toBe('無料プラン');
    });
  });

  describe('limit', () => {
    test('isLimitAvailable=false → isLimitValid は常に true', () => {
      const m = createManage();
      expect(m.isLimitValid()).toBe(true);
    });

    test('decrementLimit → limit 減少', () => {
      const m = createManage();
      m.setLimitAvailable(true);
      m.setLimit(2);
      expect(m.isLimitValid()).toBe(true);
      m.decrementLimit();
      expect(m.isLimitValid()).toBe(true);
      m.decrementLimit();
      expect(m.isLimitValid()).toBe(false);
    });
  });

  describe('applyTags', () => {
    test('fees をソートして feeMap のタグ名に変換、残りのタグを追加', () => {
      const m = new DownloadManage(
        'testUser',
        new Map([
          [100, 'ファン'],
          [500, 'サポーター'],
        ]),
      );
      m.addFee(500);
      m.addFee(100);
      m.addTags('タグA', 'タグB');
      m.applyTags();
      const json = JSON.parse(m.downloadObject.stringify());
      // fees は昇順ソート (100, 500) → ["ファン", "サポーター"] + 残りのタグ
      expect(json.tags).toEqual(['ファン', 'サポーター', 'タグA', 'タグB']);
    });
  });
});

describe('buildFailureMessage', () => {
  const counts = (over: Partial<Record<'restricted' | 'missingBody' | 'unsupported' | 'pages', number>> = {}) => ({
    restricted: 0,
    missingBody: 0,
    unsupported: 0,
    pages: 0,
    ...over,
  });

  test('失敗が無ければ通知しない', () => {
    expect(buildFailureMessage(counts())).toBeUndefined();
  });

  test('閲覧制限だけなら見出しを付けずに 1 行で伝える', () => {
    const message = buildFailureMessage(counts({ restricted: 3 }));
    expect(message).toBe('閲覧制限により取得できなかった投稿: 3 件');
    expect(message).not.toContain('確認が必要な未取得');
  });

  test('確認が必要な区分だけなら閲覧条件の節を出さない', () => {
    const message = buildFailureMessage(counts({ missingBody: 2 })) ?? '';
    expect(message).toContain('確認が必要な未取得');
    expect(message).toContain('2 件');
    expect(message).not.toContain('閲覧条件による未取得');
  });

  test('併存するとき確認が必要な区分を先に出す', () => {
    const message = buildFailureMessage(counts({ restricted: 35, missingBody: 10 })) ?? '';
    expect(message.indexOf('確認が必要な未取得')).toBeLessThan(message.indexOf('閲覧条件による未取得'));
  });

  test('ページ単位の失敗は件数と合算せずページ単位で出す', () => {
    const message = buildFailureMessage(counts({ restricted: 1, pages: 1 })) ?? '';
    expect(message).toContain('1 ページ');
    expect(message).not.toContain('2 件');
  });

  test('原因を推測しない', () => {
    const message = buildFailureMessage(counts({ missingBody: 5, unsupported: 1, pages: 1 })) ?? '';
    expect(message).not.toContain('レート制限');
    expect(message).not.toContain('支援プラン');
  });
});

describe('searchBy - API レスポンスのアンラップと失敗の集計', () => {
  const CREATOR_ID = 'testcreator';
  const LIST_PAGE_URL = 'https://api.fanbox.cc/post.listCreator?creatorId=testcreator&cursor=1';
  const LIST_PAGE_URL_2 = 'https://api.fanbox.cc/post.listCreator?creatorId=testcreator&cursor=2';
  const postInfoUrl = (postId: string) => `https://api.fanbox.cc/post.info?postId=${postId}`;
  const POST_INFO_URL = postInfoUrl('1001');

  const listItem = (postId: string, over: Record<string, unknown> = {}) => ({
    id: postId,
    isRestricted: false,
    feeRequired: 0,
    ...over,
  });
  const POST_STUB = listItem('1001');
  const POST_FULL = {
    id: '1001',
    title: 'リンゴ',
    feeRequired: 0,
    creatorId: CREATOR_ID,
    coverImageUrl: null,
    excerpt: '',
    isRestricted: false,
    tags: [],
    publishedDatetime: '2024-01-01T00:00:00+09:00',
    updatedDatetime: '2024-01-01T00:00:00+09:00',
    likeCount: 0,
    commentCount: 0,
    type: 'text',
    body: { text: 'hello' },
  };
  const fullPost = (postId: string, over: Record<string, unknown> = {}) => ({ ...POST_FULL, id: postId, ...over });

  /** 一覧までは正常形状で返す共通のモック定義 */
  const baseResponses = (): Record<string, unknown> => ({
    [`https://api.fanbox.cc/plan.listCreator?creatorId=${CREATOR_ID}`]: { body: { plans: [] } },
    [`https://api.fanbox.cc/tag.getFeatured?creatorId=${CREATOR_ID}`]: { body: { featuredTags: [] } },
    [`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`]: { body: { pageUrls: [LIST_PAGE_URL] } },
    [LIST_PAGE_URL]: { body: { posts: [POST_STUB] } },
    [POST_INFO_URL]: { body: { post: POST_FULL } },
  });

  // biome-ignore lint/suspicious/noExplicitAny: global stubs
  const g = globalThis as any;
  const orig = {
    httpGetAs: DownloadManage.utils.httpGetAs,
    sleep: DownloadManage.utils.sleep,
    alert: g.alert,
    confirm: g.confirm,
    prompt: g.prompt,
  };
  let alerts: string[];
  /** 実際に発行された URL。「叩かないこと」を欠落ではなく記録で確かめるために持つ */
  let requested: string[];

  function mockApi(responses: Record<string, unknown>, options: { ignoreFree?: boolean } = {}) {
    alerts = [];
    requested = [];
    DownloadManage.utils.httpGetAs = ((url: string) => {
      requested.push(url);
      if (!(url in responses)) throw new Error(`HTTP 404: ${url}`);
      return responses[url];
    }) as typeof DownloadManage.utils.httpGetAs;
    // レート制限の待機はテストでは不要
    DownloadManage.utils.sleep = (() => Promise.resolve()) as typeof DownloadManage.utils.sleep;
    g.alert = (message: string) => alerts.push(message);
    // 「無料コンテンツを省く？」への回答
    g.confirm = () => options.ignoreFree === true;
    g.prompt = () => null;
  }

  const postCount = (result: { stringify(): string } | undefined) =>
    JSON.parse(result?.stringify() ?? '{}').posts.length;

  afterEach(() => {
    DownloadManage.utils.httpGetAs = orig.httpGetAs;
    DownloadManage.utils.sleep = orig.sleep;
    g.alert = orig.alert;
    g.confirm = orig.confirm;
    g.prompt = orig.prompt;
  });

  test('新形状のレスポンスから投稿を収集できる', async () => {
    mockApi(baseResponses());
    const result = await searchBy(CREATOR_ID, undefined);
    expect(result).toBeDefined();
    expect(postCount(result)).toBe(1);
    expect(alerts).toEqual([]);
  });

  test.each([
    ['post.paginateCreator', `https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`, { body: [] }],
    ['post.listCreator', LIST_PAGE_URL, { body: [POST_STUB] }],
    ['post.info', POST_INFO_URL, { body: POST_FULL }],
  ])('%s が旧形状なら結果を返さない', async (_name, url, oldShape) => {
    mockApi({ ...baseResponses(), [url]: oldShape });
    // 途中まで集めた中身のない結果を成功として出さないこと
    expect(await searchBy(CREATOR_ID, undefined)).toBeUndefined();
    expect(alerts.length).toBeGreaterThan(0);
  });

  test('plan / tag が旧形状でも収集は続く (表示の補助でしかないため)', async () => {
    mockApi({
      ...baseResponses(),
      [`https://api.fanbox.cc/plan.listCreator?creatorId=${CREATOR_ID}`]: { body: [{ fee: 500, title: 'x' }] },
      [`https://api.fanbox.cc/tag.getFeatured?creatorId=${CREATOR_ID}`]: { body: [{ tag: 'x' }] },
    });
    const result = await searchBy(CREATOR_ID, undefined);
    expect(postCount(result)).toBe(1);
  });

  test('閲覧できない投稿は post.info を叩かず閲覧制限として数える', async () => {
    mockApi({ ...baseResponses(), [LIST_PAGE_URL]: { body: { posts: [listItem('1001', { isRestricted: true })] } } });
    const result = await searchBy(CREATOR_ID, undefined);
    expect(postCount(result)).toBe(0);
    expect(requested).not.toContain(POST_INFO_URL);
    expect(alerts.join()).toContain('閲覧制限により取得できなかった投稿: 1 件');
  });

  test('無料を省く設定のとき、無料投稿は post.info を叩かず失敗にも数えない', async () => {
    mockApi(
      {
        ...baseResponses(),
        [LIST_PAGE_URL]: { body: { posts: [listItem('1001'), listItem('1002', { feeRequired: 500 })] } },
        [postInfoUrl('1002')]: { body: { post: fullPost('1002', { feeRequired: 500 }) } },
      },
      { ignoreFree: true },
    );
    const result = await searchBy(CREATOR_ID, undefined);
    expect(postCount(result)).toBe(1);
    expect(requested).not.toContain(POST_INFO_URL);
    expect(requested).toContain(postInfoUrl('1002'));
    // 意図的な除外は失敗ではない
    expect(alerts).toEqual([]);
  });

  test('post.info の呼び出しが失敗した投稿は本文を利用できなかったものとして数える', async () => {
    const responses = baseResponses();
    delete responses[POST_INFO_URL];
    mockApi(responses);
    const result = await searchBy(CREATOR_ID, undefined);
    expect(postCount(result)).toBe(0);
    expect(alerts.join()).toContain('投稿詳細を取得できないか、本文を利用できなかった投稿: 1 件');
  });

  test('post.info は成功しても本文が無い投稿は本文を利用できなかったものとして数える', async () => {
    mockApi({ ...baseResponses(), [POST_INFO_URL]: { body: { post: { ...POST_FULL, body: null } } } });
    const result = await searchBy(CREATOR_ID, undefined);
    expect(postCount(result)).toBe(0);
    expect(alerts.join()).toContain('投稿詳細を取得できないか、本文を利用できなかった投稿: 1 件');
  });

  test('未知の投稿タイプは未対応として数える', async () => {
    mockApi({
      ...baseResponses(),
      [POST_INFO_URL]: { body: { post: { ...POST_FULL, type: 'image-v2', body: { text: 'x' } } } },
    });
    const result = await searchBy(CREATOR_ID, undefined);
    expect(postCount(result)).toBe(0);
    expect(alerts.join()).toContain('未対応の投稿形式: 1 件');
  });

  test('本文の必須フィールドが欠けた投稿があると即座に中断し、部分結果を返さない', async () => {
    mockApi({
      ...baseResponses(),
      [LIST_PAGE_URL]: { body: { posts: [listItem('1001'), listItem('1002'), listItem('1003')] } },
      // 既知タイプなのに body.text が string でない = 構造的な不一致
      [postInfoUrl('1002')]: { body: { post: fullPost('1002', { body: { text: 123 } }) } },
      [postInfoUrl('1003')]: { body: { post: fullPost('1003') } },
    });
    expect(await searchBy(CREATOR_ID, undefined)).toBeUndefined();
    // 中断後の投稿は取得しない
    expect(requested).not.toContain(postInfoUrl('1003'));
    // ページ単位の失敗に丸めない
    expect(alerts.join()).not.toContain('ページ');
    expect(alerts.join()).toContain('仕様が変わった可能性');
  });

  test('単一投稿モードでも本文の必須フィールド欠落で結果を返さない', async () => {
    mockApi({ ...baseResponses(), [POST_INFO_URL]: { body: { post: { ...POST_FULL, body: { text: 123 } } } } });
    expect(await searchBy(CREATOR_ID, '1001')).toBeUndefined();
    expect(alerts.join()).toContain('仕様が変わった可能性');
  });

  test('単一投稿モードでも post.info が旧形状なら結果を返さない', async () => {
    mockApi({ ...baseResponses(), [POST_INFO_URL]: { body: POST_FULL } });
    expect(await searchBy(CREATOR_ID, '1001')).toBeUndefined();
    expect(alerts.join()).toContain('仕様が変わった可能性');
  });

  test('閲覧制限と一覧ページの失敗は合算しない', async () => {
    mockApi({
      ...baseResponses(),
      [`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`]: {
        body: { pageUrls: [LIST_PAGE_URL, LIST_PAGE_URL_2] },
      },
      [LIST_PAGE_URL]: { body: { posts: [listItem('1001', { isRestricted: true })] } },
      // LIST_PAGE_URL_2 は未定義なので取得に失敗する
    });
    const result = await searchBy(CREATOR_ID, undefined);
    expect(result).toBeDefined();
    const message = alerts.join();
    expect(message).toContain('閲覧制限のある投稿: 1 件');
    expect(message).toContain('1 ページ');
    expect(message).not.toContain('2 件');
  });

  test('feeRequired が number でない一覧要素は形状の不一致として中断する', async () => {
    mockApi({
      ...baseResponses(),
      [LIST_PAGE_URL]: { body: { posts: [{ id: '1001', isRestricted: false, feeRequired: '0' }] } },
    });
    expect(await searchBy(CREATOR_ID, undefined)).toBeUndefined();
    expect(requested).not.toContain(POST_INFO_URL);
    expect(alerts.join()).toContain('仕様が変わった可能性');
  });
});
