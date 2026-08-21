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
import {
  ApiSession,
  buildFailureMessage,
  HttpError,
  pageOriginTransport,
  parseRetryAfterMs,
  RateLimitExhaustedError,
  searchBy,
  TransportExhaustedError,
  type TransportResult,
} from './fanbox-downloader';

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
    expect(buildFailureMessage(counts({ restricted: 3 }))).toBe('閲覧制限により取得できなかった投稿: 3 件');
  });

  test('確認が必要な区分だけなら閲覧条件の節を出さない', () => {
    expect(buildFailureMessage(counts({ missingBody: 2 }))).toBe(
      [
        '一部の投稿を取得できませんでした。',
        '',
        '確認が必要な未取得:',
        '- 投稿詳細を取得できないか、本文を利用できなかった投稿: 2 件',
      ].join('\n'),
    );
  });

  test('未対応の投稿形式だけなら他の区分を出さない', () => {
    expect(buildFailureMessage(counts({ unsupported: 1 }))).toBe(
      ['一部の投稿を取得できませんでした。', '', '確認が必要な未取得:', '- 未対応の投稿形式: 1 件'].join('\n'),
    );
  });

  test('一覧ページの失敗だけならページ単位で出す', () => {
    expect(buildFailureMessage(counts({ pages: 1 }))).toBe(
      [
        '一部の投稿を取得できませんでした。',
        '',
        '確認が必要な未取得:',
        '- 取得できなかった投稿一覧: 1 ページ (欠落した投稿数は不明)',
      ].join('\n'),
    );
  });

  // 全区分の完全一致で、件数・順序・余分な区分・原因を推測する文言の混入をまとめて固定する
  // (原因を書かないのは、missing-body に CORS・通信断・API 障害・レート制限・仕様変更・
  // 実際の本文欠落が合流しており、件数からは識別できないため)
  test('レート制限で打ち切ったことを先頭で伝え、どこまで取れたかを示す', () => {
    const message =
      buildFailureMessage(counts({ missingBody: 1 }), {
        reason: 'rate-limit-exhausted',
        addedPostCount: 12,
        page: 3,
      }) ?? '';
    expect(message.startsWith('レート制限のため途中で打ち切りました')).toBe(true);
    expect(message).toContain('ここまでに取り込めた投稿: 12 件');
    expect(message).toContain('3 ページ目で停止');
    expect(message).toContain('不完全な結果');
    expect(message).toContain('確認が必要な未取得');
  });

  test('1 件も取り込めていない打ち切りは、部分結果があるかのように書かない', () => {
    const message = buildFailureMessage(counts(), { reason: 'transport-exhausted', addedPostCount: 0 }) ?? '';
    expect(message.startsWith('通信に失敗したため途中で打ち切りました')).toBe(true);
    expect(message).toContain('取り込めた投稿が無いため、結果は出力しません');
    expect(message).not.toContain('不完全な結果');
    // ページが分からない経路では位置を書かない
    expect(message).not.toContain('ページ目で停止');
  });

  test('全区分が併存するとき、確認が必要な区分を先に置いて原因は書かない', () => {
    expect(buildFailureMessage(counts({ restricted: 35, missingBody: 10, unsupported: 2, pages: 1 }))).toBe(
      [
        '一部の投稿を取得できませんでした。',
        '',
        '確認が必要な未取得:',
        '- 投稿詳細を取得できないか、本文を利用できなかった投稿: 10 件',
        '- 未対応の投稿形式: 2 件',
        '- 取得できなかった投稿一覧: 1 ページ (欠落した投稿数は不明)',
        '',
        '閲覧条件による未取得:',
        '- 閲覧制限のある投稿: 35 件',
      ].join('\n'),
    );
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
  let session: ApiSession;

  /** 応答定義から transport を組み、セッションごと差し替える */
  function mockApi(responses: Record<string, unknown>, options: { ignoreFree?: boolean } = {}) {
    alerts = [];
    requested = [];
    const transport = async (url: string): Promise<TransportResult> => {
      requested.push(url);
      if (!(url in responses)) return { kind: 'response', status: 404, body: '', retryAfter: null };
      return { kind: 'response', status: 200, body: JSON.stringify(responses[url]), retryAfter: null };
    };
    // 発行間隔の待機はテストでは不要
    session = new ApiSession(0, transport, { sleep: async () => {}, now: () => 0 });
    g.alert = (message: string) => alerts.push(message);
    // 「無料コンテンツを省く？」への回答
    g.confirm = () => options.ignoreFree === true;
    g.prompt = () => null;
  }

  /** 応答定義ではなく transport そのものを差し替えたいとき用 */
  function mockApiWithTransport(transport: (url: string) => Promise<TransportResult>) {
    alerts = [];
    requested = [];
    session = new ApiSession(
      0,
      async (url) => {
        requested.push(url);
        return transport(url);
      },
      { sleep: async () => {}, now: () => 0 },
    );
    g.alert = (message: string) => alerts.push(message);
    g.confirm = () => false;
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
    const result = await searchBy(CREATOR_ID, undefined, session);
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
    expect(await searchBy(CREATOR_ID, undefined, session)).toBeUndefined();
    // 経路によらず同じ分類の通知になること
    expect(alerts.join()).toContain('仕様が変わった可能性');
  });

  test('plan / tag が旧形状でも収集は続く (表示の補助でしかないため)', async () => {
    mockApi({
      ...baseResponses(),
      [`https://api.fanbox.cc/plan.listCreator?creatorId=${CREATOR_ID}`]: { body: [{ fee: 500, title: 'x' }] },
      [`https://api.fanbox.cc/tag.getFeatured?creatorId=${CREATOR_ID}`]: { body: [{ tag: 'x' }] },
    });
    const result = await searchBy(CREATOR_ID, undefined, session);
    expect(postCount(result)).toBe(1);
  });

  test('閲覧できない投稿は post.info を叩かず閲覧制限として数える', async () => {
    mockApi({ ...baseResponses(), [LIST_PAGE_URL]: { body: { posts: [listItem('1001', { isRestricted: true })] } } });
    const result = await searchBy(CREATOR_ID, undefined, session);
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
    const result = await searchBy(CREATOR_ID, undefined, session);
    expect(postCount(result)).toBe(1);
    expect(requested).not.toContain(POST_INFO_URL);
    expect(requested).toContain(postInfoUrl('1002'));
    // 意図的な除外は失敗ではない
    expect(alerts).toEqual([]);
  });

  test('無料を省く設定では、閲覧制限のある無料投稿も失敗に数えない', async () => {
    // isIgnoreFree を isRestricted より先に判定する契約。逆順にすると閲覧制限として数えてしまう
    mockApi(
      {
        ...baseResponses(),
        [LIST_PAGE_URL]: { body: { posts: [listItem('1001', { isRestricted: true })] } },
      },
      { ignoreFree: true },
    );
    const result = await searchBy(CREATOR_ID, undefined, session);
    expect(postCount(result)).toBe(0);
    expect(requested).not.toContain(POST_INFO_URL);
    expect(alerts).toEqual([]);
  });

  test('post.info の呼び出しが失敗した投稿は本文を利用できなかったものとして数える', async () => {
    const responses = baseResponses();
    delete responses[POST_INFO_URL];
    mockApi(responses);
    const result = await searchBy(CREATOR_ID, undefined, session);
    expect(postCount(result)).toBe(0);
    expect(alerts.join()).toContain('投稿詳細を取得できないか、本文を利用できなかった投稿: 1 件');
  });

  test('post.info は成功しても本文が無い投稿は本文を利用できなかったものとして数える', async () => {
    mockApi({ ...baseResponses(), [POST_INFO_URL]: { body: { post: { ...POST_FULL, body: null } } } });
    const result = await searchBy(CREATOR_ID, undefined, session);
    expect(postCount(result)).toBe(0);
    expect(alerts.join()).toContain('投稿詳細を取得できないか、本文を利用できなかった投稿: 1 件');
  });

  test('未知の投稿タイプは未対応として数える', async () => {
    mockApi({
      ...baseResponses(),
      [POST_INFO_URL]: { body: { post: { ...POST_FULL, type: 'image-v2', body: { text: 'x' } } } },
    });
    const result = await searchBy(CREATOR_ID, undefined, session);
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
    expect(await searchBy(CREATOR_ID, undefined, session)).toBeUndefined();
    // 中断後の投稿は取得しない
    expect(requested).not.toContain(postInfoUrl('1003'));
    // ページ単位の失敗に丸めない
    expect(alerts.join()).not.toContain('ページ');
    expect(alerts.join()).toContain('仕様が変わった可能性');
  });

  test('単一投稿モードでも本文の必須フィールド欠落で結果を返さない', async () => {
    mockApi({ ...baseResponses(), [POST_INFO_URL]: { body: { post: { ...POST_FULL, body: { text: 123 } } } } });
    expect(await searchBy(CREATOR_ID, '1001', session)).toBeUndefined();
    expect(alerts.join()).toContain('仕様が変わった可能性');
  });

  test('単一投稿モードでも post.info が旧形状なら結果を返さない', async () => {
    mockApi({ ...baseResponses(), [POST_INFO_URL]: { body: POST_FULL } });
    expect(await searchBy(CREATOR_ID, '1001', session)).toBeUndefined();
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
    const result = await searchBy(CREATOR_ID, undefined, session);
    expect(result).toBeDefined();
    const message = alerts.join();
    expect(message).toContain('閲覧制限のある投稿: 1 件');
    expect(message).toContain('1 ページ');
    expect(message).not.toContain('2 件');
  });

  test('一覧では閲覧できても詳細で閲覧制限なら閲覧制限として数える', async () => {
    // 一覧取得後に権限が変わる場合の防御。一覧側の事前スキップでは拾えない経路
    mockApi({
      ...baseResponses(),
      [LIST_PAGE_URL]: { body: { posts: [listItem('1001', { feeRequired: 500 })] } },
      [POST_INFO_URL]: { body: { post: fullPost('1001', { feeRequired: 500, isRestricted: true }) } },
    });
    const result = await searchBy(CREATOR_ID, undefined, session);
    expect(postCount(result)).toBe(0);
    // 事前スキップではなく詳細を叩いた結果として数えていること
    expect(requested).toContain(POST_INFO_URL);
    expect(alerts.join()).toContain('閲覧制限により取得できなかった投稿: 1 件');
  });

  test('一覧では有料でも詳細が無料なら、無料を省く設定で失敗に数えない', async () => {
    mockApi(
      {
        ...baseResponses(),
        [LIST_PAGE_URL]: { body: { posts: [listItem('1001', { feeRequired: 500 })] } },
        [POST_INFO_URL]: { body: { post: fullPost('1001', { feeRequired: 0 }) } },
      },
      { ignoreFree: true },
    );
    const result = await searchBy(CREATOR_ID, undefined, session);
    expect(postCount(result)).toBe(0);
    expect(requested).toContain(POST_INFO_URL);
    // 意図的な除外は失敗ではない
    expect(alerts).toEqual([]);
  });

  test('投稿単位の想定外の例外はページの失敗に数えず中止する', async () => {
    // transport が契約どおり unobservable-failure を返さず例外を投げた場合。
    // 実装上のバグでありうるので、投稿単位の失敗に丸めず中止する
    const responses = baseResponses();
    mockApiWithTransport(async (url) => {
      if (url === POST_INFO_URL) throw new Error('boom');
      return { kind: 'response', status: 200, body: JSON.stringify(responses[url] ?? null), retryAfter: null };
    });
    expect(await searchBy(CREATOR_ID, undefined, session)).toBeUndefined();
    expect(alerts.join()).toContain('予期しないエラー');
    expect(alerts.join()).not.toContain('ページ');
  });

  test('一覧取得の想定外の例外もページの失敗に数えず中止する', async () => {
    const responses = baseResponses();
    mockApiWithTransport(async (url) => {
      if (url === LIST_PAGE_URL) throw new Error('boom');
      return { kind: 'response', status: 200, body: JSON.stringify(responses[url] ?? null), retryAfter: null };
    });
    expect(await searchBy(CREATOR_ID, undefined, session)).toBeUndefined();
    expect(alerts.join()).toContain('予期しないエラー');
    expect(alerts.join()).not.toContain('ページ');
  });

  test('収集の途中で再試行枠を使い切ったら、集めた分を不完全と明示して返す', async () => {
    const responses = baseResponses();
    responses[LIST_PAGE_URL] = { body: { posts: [listItem('1001'), listItem('1002')] } };
    responses[postInfoUrl('1002')] = { body: { post: fullPost('1002') } };
    mockApiWithTransport(async (url) => {
      // 2 件目の投稿詳細だけが最後まで観測できない
      if (url === postInfoUrl('1002')) return { kind: 'unobservable-failure' };
      return { kind: 'response', status: 200, body: JSON.stringify(responses[url] ?? null), retryAfter: null };
    });
    const result = await searchBy(CREATOR_ID, undefined, session);
    // 集めた分は捨てない
    expect(postCount(result)).toBe(1);
    // 収集側から件数と停止位置が伝わること (手入力ではなく実際の収集結果で確かめる)
    expect(alerts.join()).toContain('通信に失敗したため途中で打ち切りました');
    expect(alerts.join()).toContain('ここまでに取り込めた投稿: 1 件');
    expect(alerts.join()).toContain('1 ページ目で停止');
  });

  test('レート制限で枯渇したら、部分結果と停止位置を伝えて後続を要求しない', async () => {
    const responses = baseResponses();
    responses[LIST_PAGE_URL] = { body: { posts: [listItem('1001'), listItem('1002')] } };
    responses[postInfoUrl('1002')] = { body: { post: fullPost('1002') } };
    mockApiWithTransport(async (url) => {
      // 1 件目は成功させ、2 件目だけ 429 を返し続けて枯渇させる
      if (url === postInfoUrl('1002')) return { kind: 'response', status: 429, body: '', retryAfter: null };
      return { kind: 'response', status: 200, body: JSON.stringify(responses[url] ?? null), retryAfter: null };
    });
    const result = await searchBy(CREATOR_ID, undefined, session);
    expect(postCount(result)).toBe(1);
    expect(alerts.join()).toContain('レート制限のため途中で打ち切りました');
    expect(alerts.join()).toContain('ここまでに取り込めた投稿: 1 件');
    expect(alerts.join()).toContain('1 ページ目で停止');
    // 429 は初回 + 3 回再試行で打ち切る
    expect(requested.filter((u) => u === postInfoUrl('1002'))).toHaveLength(4);
  });

  test('1 件も取り込めずに枯渇したら結果を返さない', async () => {
    const responses = baseResponses();
    mockApiWithTransport(async (url) => {
      if (url === POST_INFO_URL) return { kind: 'unobservable-failure' };
      return { kind: 'response', status: 200, body: JSON.stringify(responses[url] ?? null), retryAfter: null };
    });
    // plan / tag / paginate / 単一投稿での枯渇と扱いを揃える
    expect(await searchBy(CREATOR_ID, undefined, session)).toBeUndefined();
    expect(alerts.join()).toContain('取り込めた投稿が無いため、結果は出力しません');
  });

  test('枯渇後は次の投稿を要求しない', async () => {
    const responses = baseResponses();
    responses[LIST_PAGE_URL] = { body: { posts: [listItem('1001'), listItem('1002')] } };
    responses[postInfoUrl('1002')] = { body: { post: fullPost('1002') } };
    mockApiWithTransport(async (url) => {
      if (url === POST_INFO_URL) return { kind: 'unobservable-failure' };
      return { kind: 'response', status: 200, body: JSON.stringify(responses[url] ?? null), retryAfter: null };
    });
    await searchBy(CREATOR_ID, undefined, session);
    // 1 件目で枯渇したので 2 件目は叩かない
    expect(requested).not.toContain(postInfoUrl('1002'));
  });

  test('取得上限に達したら残りの一覧ページを要求しない', async () => {
    const responses = baseResponses();
    responses[`https://api.fanbox.cc/post.paginateCreator?creatorId=${CREATOR_ID}`] = {
      body: { pageUrls: [LIST_PAGE_URL, LIST_PAGE_URL_2] },
    };
    responses[LIST_PAGE_URL_2] = { body: { posts: [] } };
    mockApiWithTransport(async (url) => ({
      kind: 'response',
      status: 200,
      body: JSON.stringify(responses[url] ?? null),
      retryAfter: null,
    }));
    // 「取得制限数を入力」に 1 を返す
    g.prompt = () => '1';
    await searchBy(CREATOR_ID, undefined, session);
    expect(requested).toContain(LIST_PAGE_URL);
    expect(requested).not.toContain(LIST_PAGE_URL_2);
    // 完了しているので打ち切りとして通知しない
    expect(alerts.join()).not.toContain('打ち切りました');
  });

  test('プラン情報の取得で枯渇したら収集に進まない', async () => {
    const responses = baseResponses();
    const planUrl = `https://api.fanbox.cc/plan.listCreator?creatorId=${CREATOR_ID}`;
    mockApiWithTransport(async (url) => {
      if (url === planUrl) return { kind: 'unobservable-failure' };
      return { kind: 'response', status: 200, body: JSON.stringify(responses[url] ?? null), retryAfter: null };
    });
    expect(await searchBy(CREATOR_ID, undefined, session)).toBeUndefined();
    expect(alerts.join()).toContain('通信に失敗したため途中で打ち切りました');
    // 既に上限まで待った直後に別のエンドポイントへ要求を出さない
    expect(requested.some((u) => u.includes('post.paginateCreator'))).toBe(false);
  });

  test('feeRequired が number でない一覧要素は形状の不一致として中断する', async () => {
    mockApi({
      ...baseResponses(),
      [LIST_PAGE_URL]: { body: { posts: [{ id: '1001', isRestricted: false, feeRequired: '0' }] } },
    });
    expect(await searchBy(CREATOR_ID, undefined, session)).toBeUndefined();
    expect(requested).not.toContain(POST_INFO_URL);
    expect(alerts.join()).toContain('仕様が変わった可能性');
  });
});

describe('parseRetryAfterMs', () => {
  const NOW = Date.parse('2026-08-21T00:00:00Z');

  test.each([
    ['秒数', '30', 30_000],
    ['秒数の 0', '0', 0],
    ['前後の空白を無視する', '  7  ', 7_000],
  ])('%s を待機ミリ秒に変換する', (_name, value, expected) => {
    expect(parseRetryAfterMs(value as string, NOW)).toBe(expected as number);
  });

  test('HTTP-date は現在時刻との差になる', () => {
    expect(parseRetryAfterMs('Fri, 21 Aug 2026 00:00:20 GMT', NOW)).toBe(20_000);
  });

  test('過去の HTTP-date は 0 に切り上げる', () => {
    expect(parseRetryAfterMs('Thu, 20 Aug 2026 00:00:00 GMT', NOW)).toBe(0);
  });

  test.each([
    ['null', null],
    ['空文字', ''],
    ['空白のみ', '   '],
    ['解釈できない文字列', 'soon'],
    ['負の秒数', '-5'],
    ['HTTP-date ではない日付表記', '1 Jan 2027'],
    ['英語の日付表記', 'August 21, 2026'],
    ['指数表記', '1e-3'],
    ['16 進表記', '0x10'],
    ['存在しない日付', 'Thu, 31 Sep 2026 00:00:00 GMT'],
    ['曜日が食い違う日付', 'Mon, 21 Aug 2026 00:00:00 GMT'],
    ['24 時表記', 'Fri, 21 Aug 2026 24:00:00 GMT'],
  ])('%s は undefined になる (固定バックオフへ落とす)', (_name, value) => {
    expect(parseRetryAfterMs(value as string | null, NOW)).toBeUndefined();
  });
});

describe('pageOriginTransport', () => {
  // biome-ignore lint/suspicious/noExplicitAny: global stubs
  const g = globalThis as any;
  const origXhr = g.XMLHttpRequest;

  type XhrPlan = {
    throwOnSend?: unknown;
    throwOnOpen?: unknown;
    status?: number;
    text?: string;
    headers?: Record<string, string>;
  };
  let plan: XhrPlan;
  let opened: { method: string; url: string; async: boolean } | undefined;
  let withCredentials: boolean | undefined;

  function stubXhr(next: XhrPlan) {
    plan = next;
    opened = undefined;
    withCredentials = undefined;
    g.XMLHttpRequest = class {
      status = 0;
      responseText = '';
      withCredentials = false;
      open(method: string, url: string, async: boolean) {
        if (plan.throwOnOpen) throw plan.throwOnOpen;
        opened = { method, url, async };
      }
      send() {
        withCredentials = this.withCredentials;
        if (plan.throwOnSend) throw plan.throwOnSend;
        this.status = plan.status ?? 200;
        this.responseText = plan.text ?? '';
      }
      getResponseHeader(name: string) {
        return plan.headers?.[name.toLowerCase()] ?? null;
      }
    };
  }

  afterEach(() => {
    g.XMLHttpRequest = origXhr;
  });

  test('同期 XHR を資格情報つきで発行する', async () => {
    stubXhr({ status: 200, text: '{}' });
    await pageOriginTransport('https://api.fanbox.cc/x');
    expect(opened).toEqual({ method: 'GET', url: 'https://api.fanbox.cc/x', async: false });
    expect(withCredentials).toBe(true);
  });

  test('応答を読めたら status と本文を返す', async () => {
    stubXhr({ status: 200, text: '{"a":1}' });
    expect(await pageOriginTransport('https://api.fanbox.cc/x')).toEqual({
      kind: 'response',
      status: 200,
      body: '{"a":1}',
      retryAfter: null,
    });
  });

  test('2xx 以外も response として返す (status を捨てない)', async () => {
    stubXhr({ status: 429, text: '', headers: { 'retry-after': '30' } });
    expect(await pageOriginTransport('https://api.fanbox.cc/x')).toEqual({
      kind: 'response',
      status: 429,
      body: '',
      retryAfter: '30',
    });
  });

  test('通信の失敗 (DOMException) は status を推測せず unobservable-failure にする', async () => {
    stubXhr({ throwOnSend: new DOMException('Failed to load', 'NetworkError') });
    const result = await pageOriginTransport('https://api.fanbox.cc/x');
    expect(result.kind).toBe('unobservable-failure');
    // status を推測して混入させない
    expect(result).not.toHaveProperty('status');
  });

  test('send の想定外の例外は通信障害に丸めない', async () => {
    // 通信の失敗は NetworkError として規定されている。それ以外は実装上のバグでありうる
    stubXhr({ throwOnSend: new TypeError('想定外') });
    await expect(pageOriginTransport('https://api.fanbox.cc/x')).rejects.toBeInstanceOf(TypeError);
  });

  test('DOMException でも状態違反は通信障害に丸めない', async () => {
    stubXhr({ throwOnSend: new DOMException('not opened', 'InvalidStateError') });
    await expect(pageOriginTransport('https://api.fanbox.cc/x')).rejects.toBeInstanceOf(DOMException);
  });

  test('URL の構文エラーは通信障害に丸めない', async () => {
    // 一覧の pageUrls は文字列であることしか検証しないので、仕様変更で不正な URL が来うる
    stubXhr({ throwOnOpen: new DOMException('Invalid URL', 'SyntaxError') });
    await expect(pageOriginTransport('http://[')).rejects.toBeInstanceOf(DOMException);
  });

  test('status 0 も unobservable-failure にする', async () => {
    stubXhr({ status: 0, text: '' });
    expect(await pageOriginTransport('https://api.fanbox.cc/x')).toEqual({ kind: 'unobservable-failure' });
  });
});

describe('ApiSession - transport 契約と再試行ポリシー', () => {
  const URL = 'https://api.fanbox.cc/post.info?postId=1';

  /** 決定的に検証するため sleep と now を注入する。sleep は待機時間を記録するだけ */
  const createHarness = (results: TransportResult[], baseInterval = 500) => {
    const waits: number[] = [];
    const requested: string[] = [];
    let clock = 1_000_000;
    const queue = [...results];
    const transport = async (url: string): Promise<TransportResult> => {
      requested.push(url);
      const next = queue.shift();
      if (!next) throw new Error('transport の応答が足りない');
      return next;
    };
    const session = new ApiSession(baseInterval, transport, {
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    });
    return {
      session,
      waits,
      requested,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  };

  const ok = (body: string): TransportResult => ({ kind: 'response', status: 200, body, retryAfter: null });
  const tooMany = (retryAfter: string | null = null): TransportResult => ({
    kind: 'response',
    status: 429,
    body: '',
    retryAfter,
  });
  const failure = (): TransportResult => ({ kind: 'unobservable-failure' });

  test('200 なら JSON を返し、待機は発行間隔のみ', async () => {
    const h = createHarness([ok('{"a":1}')]);
    expect(await h.session.fetchJson<{ a: number }, { a: number }>(URL, (j) => j)).toEqual({ a: 1 });
    expect(h.requested).toHaveLength(1);
    expect(h.waits).toEqual([]);
  });

  test('429 は 5 / 15 / 45 秒で 3 回再試行し、枯渇したら RateLimitExhaustedError', async () => {
    const h = createHarness([tooMany(), tooMany(), tooMany(), tooMany()]);
    await expect(h.session.fetchJson<unknown, unknown>(URL, (j) => j)).rejects.toBeInstanceOf(RateLimitExhaustedError);
    expect(h.requested).toHaveLength(4);
    expect(h.waits.filter((w) => w >= 5_000)).toEqual([5_000, 15_000, 45_000]);
  });

  test('読める Retry-After は固定バックオフより優先する', async () => {
    const h = createHarness([tooMany('30'), ok('{}')]);
    await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    expect(h.waits).toContain(30_000);
    expect(h.waits).not.toContain(5_000);
  });

  test('Retry-After が不正なら固定バックオフへ落とす', async () => {
    const h = createHarness([tooMany('soon'), ok('{}')]);
    await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    expect(h.waits).toContain(5_000);
  });

  test('観測できない失敗は 5 / 15 秒の 2 回だけ再試行し、枯渇したら TransportExhaustedError', async () => {
    const h = createHarness([failure(), failure(), failure()]);
    await expect(h.session.fetchJson<unknown, unknown>(URL, (j) => j)).rejects.toBeInstanceOf(TransportExhaustedError);
    // 429 と違い 45 秒は待たない
    expect(h.requested).toHaveLength(3);
    expect(h.waits.filter((w) => w >= 5_000)).toEqual([5_000, 15_000]);
  });

  test('観測できない失敗から復帰できる', async () => {
    const h = createHarness([failure(), ok('{"ok":true}')]);
    expect(await h.session.fetchJson<{ ok: boolean }, { ok: boolean }>(URL, (j) => j)).toEqual({ ok: true });
    expect(h.requested).toHaveLength(2);
  });

  test('2xx 以外は再試行せず HttpError になる', async () => {
    const h = createHarness([{ kind: 'response', status: 404, body: '', retryAfter: null }]);
    await expect(h.session.fetchJson<unknown, unknown>(URL, (j) => j)).rejects.toBeInstanceOf(HttpError);
    expect(h.requested).toHaveLength(1);
  });

  test('JSON として読めない本文は形状の問題として扱い、再試行しない', async () => {
    const h = createHarness([ok('<html>')]);
    await expect(h.session.fetchJson<unknown, unknown>(URL, (j) => j)).rejects.toThrow('API レスポンスの形状が想定外');
    expect(h.requested).toHaveLength(1);
  });

  test('exact 429 でだけ発行間隔が上がる', async () => {
    const h = createHarness([tooMany(), ok('{}')]);
    expect(h.session.intervalMs).toBe(500);
    await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    expect(h.session.intervalMs).toBe(750);
  });

  test('観測できない失敗では発行間隔を上げない (通信障害をレート制限として学習しない)', async () => {
    const h = createHarness([failure(), failure(), ok('{}')]);
    await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    expect(h.session.intervalMs).toBe(500);
  });

  test('発行間隔の引き上げには上限がある', async () => {
    const h = createHarness([tooMany(), tooMany(), tooMany(), ok('{}')], 2_000);
    await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    // cap は max(baseInterval, 3000)
    expect(h.session.intervalMs).toBe(3_000);
  });

  test('同時に呼んでも直列化される', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const transport = async (): Promise<TransportResult> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return { kind: 'response', status: 200, body: '{}', retryAfter: null };
    };
    const session = new ApiSession(0, transport, { sleep: async () => {}, now: () => 0 });
    await Promise.all([
      session.fetchJson<unknown, unknown>(URL, (j) => j),
      session.fetchJson<unknown, unknown>(URL, (j) => j),
      session.fetchJson<unknown, unknown>(URL, (j) => j),
    ]);
    expect(maxInFlight).toBe(1);
  });

  test('直列化は失敗した呼び出しの後も続く', async () => {
    const h = createHarness([{ kind: 'response', status: 404, body: '', retryAfter: null }, ok('{"n":2}')]);
    await expect(h.session.fetchJson<unknown, unknown>(URL, (j) => j)).rejects.toBeInstanceOf(HttpError);
    expect(await h.session.fetchJson<{ n: number }, { n: number }>(URL, (j) => j)).toEqual({ n: 2 });
  });

  test('連続する成功要求の間に発行間隔ぶんの待機が入る', async () => {
    const h = createHarness([ok('{}'), ok('{}')], 500);
    await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    // gate() の待機を外すとこの期待が落ちる
    expect(h.waits).toEqual([500]);
  });

  test('失敗を挟むと連続成功が切れ、減衰しない', async () => {
    // 429 で 750ms に上がったあと、成功 19 回 → HTTP 500 → 成功 1 回。
    // 「20 回継続」ではないので減衰させない
    const results: TransportResult[] = [tooMany(), ...Array(19).fill(ok('{}'))];
    results.push({ kind: 'response', status: 500, body: '', retryAfter: null });
    results.push(ok('{}'));
    const h = createHarness(results, 500);
    // 1 回目の呼び出しが 429 と再試行の成功で 2 件消費するので、成功 19 回ぶんは 19 呼び出し
    for (let i = 0; i < 19; i++) await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    expect(h.session.intervalMs).toBe(750);
    await expect(h.session.fetchJson<unknown, unknown>(URL, (j) => j)).rejects.toBeInstanceOf(HttpError);
    h.advance(120_000);
    await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    expect(h.session.intervalMs).toBe(750);
  });

  test('レート制限なしで成功が継続し静穏期間が過ぎたら減衰する', async () => {
    const h = createHarness([tooMany(), ...Array(20).fill(ok('{}'))], 500);
    // 1 回目の呼び出しで 429 → 再試行成功。以降 19 回成功して合計 20 回
    for (let i = 0; i < 20; i++) {
      h.advance(120_000);
      await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    }
    expect(h.session.intervalMs).toBe(600);
  });

  test('読めない本文は成功として数えない', async () => {
    const h = createHarness([tooMany(), ...Array(19).fill(ok('{}')), ok('<html>'), ok('{}')], 500);
    for (let i = 0; i < 19; i++) await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    await expect(h.session.fetchJson<unknown, unknown>(URL, (j) => j)).rejects.toThrow('API レスポンスの形状が想定外');
    h.advance(120_000);
    await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    expect(h.session.intervalMs).toBe(750);
  });

  test('待機の途中で中断できる', async () => {
    // 待機に入ったことを確認してから中断する。同期的に abort すると直列化タスクが
    // 始まる前に止まり、waitAbortable を外しても通ってしまう
    let enteredSleep!: () => void;
    const inSleep = new Promise<void>((resolve) => {
      enteredSleep = resolve;
    });
    let sleepCalls = 0;
    const controller = new AbortController();
    const session = new ApiSession(0, async (): Promise<TransportResult> => ({ kind: 'unobservable-failure' }), {
      sleep: () => {
        sleepCalls++;
        enteredSleep();
        // 解決しない。abort でのみ抜けられることを確かめる
        return new Promise<void>(() => {});
      },
      now: () => 0,
    });
    const pending = session.fetchJson<unknown, unknown>(URL, (j) => j, controller.signal);
    await inSleep;
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(sleepCalls).toBe(1);
  });

  test('発行中に中断したら、応答が返っても成功として扱わない', async () => {
    let enteredTransport!: () => void;
    const inTransport = new Promise<void>((resolve) => {
      enteredTransport = resolve;
    });
    let release!: (result: TransportResult) => void;
    let calls = 0;
    const controller = new AbortController();
    const session = new ApiSession(
      0,
      () => {
        calls++;
        enteredTransport();
        return new Promise<TransportResult>((resolve) => {
          release = resolve;
        });
      },
      { sleep: async () => {}, now: () => 0 },
    );
    let validated = 0;
    const pending = session.fetchJson<unknown, unknown>(
      URL,
      (j) => {
        validated++;
        return j;
      },
      controller.signal,
    );
    await inTransport;
    controller.abort();
    release({ kind: 'response', status: 200, body: '{}', retryAfter: null });
    await expect(pending).rejects.toBeDefined();
    // 中断後に追加の要求を出さない
    expect(calls).toBe(1);
    // 返却 Promise の reject だけでなく、応答の処理自体が行われないこと。
    // ここを見ないと発行後の中断検査を外しても通ってしまう
    await Promise.resolve();
    expect(validated).toBe(0);
  });

  test('キュー待ちのまま中断できる (先行要求が止まっていても伝わる)', async () => {
    let releaseFirst!: (result: TransportResult) => void;
    let calls = 0;
    const session = new ApiSession(
      0,
      () => {
        calls++;
        // 1 件目は解決しない。2 件目はキューで待つことになる
        return new Promise<TransportResult>((resolve) => {
          releaseFirst = resolve;
        });
      },
      { sleep: async () => {}, now: () => 0 },
    );
    const first = session.fetchJson<unknown, unknown>(URL, (j) => j);
    const controller = new AbortController();
    const queued = session.fetchJson<unknown, unknown>(URL, (j) => j, controller.signal);
    // 1 件目が transport に入るまで待つ
    await Promise.resolve();
    controller.abort();
    await expect(queued).rejects.toBeDefined();
    // 中断しても順序は崩さない: 2 件目は発行されていない
    expect(calls).toBe(1);
    releaseFirst({ kind: 'response', status: 200, body: '{}', retryAfter: null });
    await first;
  });

  test('成功が 20 回続いても静穏期間が満たなければ減衰しない', async () => {
    const h = createHarness([tooMany(), ...Array(20).fill(ok('{}'))], 500);
    for (let i = 0; i < 20; i++) await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    // 時計は待機ぶんしか進んでおらず、最後のレート制限から 60 秒経っていない
    expect(h.session.intervalMs).toBe(750);
  });

  test('形状検証に失敗した応答は成功として数えない', async () => {
    const h = createHarness([tooMany(), ...Array(19).fill(ok('{}')), ok('{}'), ok('{}')], 500);
    for (let i = 0; i < 19; i++) await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    await expect(
      h.session.fetchJson<unknown, unknown>(URL, () => {
        throw new Error('形状が想定外');
      }),
    ).rejects.toThrow('形状が想定外');
    h.advance(120_000);
    await h.session.fetchJson<unknown, unknown>(URL, (j) => j);
    expect(h.session.intervalMs).toBe(750);
  });

  test('中断済みの signal では要求を出さない', async () => {
    const h = createHarness([ok('{}')]);
    const controller = new AbortController();
    controller.abort();
    await expect(h.session.fetchJson<unknown, unknown>(URL, (j) => j, controller.signal)).rejects.toBeDefined();
    expect(h.requested).toHaveLength(0);
  });
});
