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
import { searchBy } from './fanbox-downloader';

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

describe('searchBy - API レスポンスのアンラップ', () => {
  const CREATOR_ID = 'testcreator';
  const LIST_PAGE_URL = 'https://api.fanbox.cc/post.listCreator?creatorId=testcreator&cursor=1';
  const POST_INFO_URL = 'https://api.fanbox.cc/post.info?postId=1001';

  const POST_STUB = { id: '1001', isRestricted: false, feeRequired: 0 };
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

  function mockApi(responses: Record<string, unknown>) {
    alerts = [];
    DownloadManage.utils.httpGetAs = ((url: string) => {
      if (!(url in responses)) throw new Error(`HTTP 404: ${url}`);
      return responses[url];
    }) as typeof DownloadManage.utils.httpGetAs;
    // レート制限の待機はテストでは不要
    DownloadManage.utils.sleep = (() => Promise.resolve()) as typeof DownloadManage.utils.sleep;
    g.alert = (message: string) => alerts.push(message);
    g.confirm = () => false;
    g.prompt = () => null;
  }

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
    expect(JSON.parse(result?.stringify() ?? '{}').posts).toHaveLength(1);
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
    expect(JSON.parse(result?.stringify() ?? '{}').posts).toHaveLength(1);
  });

  test('閲覧できない投稿は取得できなかった件数として通知する', async () => {
    mockApi({ ...baseResponses(), [LIST_PAGE_URL]: { body: { posts: [{ ...POST_STUB, isRestricted: true }] } } });
    const result = await searchBy(CREATOR_ID, undefined);
    expect(JSON.parse(result?.stringify() ?? '{}').posts).toHaveLength(0);
    expect(alerts.join()).toContain('1 件の投稿');
  });
});
