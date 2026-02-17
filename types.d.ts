/**
 * プランAPIの型
 * @see https://api.fanbox.cc/plan.listCreator?creatorId=${creatorId}
 */
type Plans = {
  body?: {
    id: string;
    title: string;
    fee: number;
    description: string;
    coverImageUrl: string;
  }[];
};

/**
 * タグAPIの型
 * @see https://api.fanbox.cc/tag.getFeatured?creatorId=${creatorId}
 */
type Tags = {
  body?: {
    tag: string;
    count: number;
    coverImageUrl: string;
  }[];
};

/**
 * 投稿情報の型
 * @see https://api.fanbox.cc/post.listCreator?creatorId=${creatorId}
 * @see https://api.fanbox.cc/post.info?postId=${postId}
 */
type PostInfo = {
  title: string;
  feeRequired: number;
  id: string;
  creatorId: string;
  coverImageUrl: string | null;
  excerpt: string;
  isRestricted: boolean;
  tags: string[];
  // DateはJSON.parseで文字列扱い
  publishedDatetime: string;
  updatedDatetime: string;
  likeCount: number;
  commentCount: number;
} & (
  | {
      type: 'image';
      body: { text: string; images: ImageInfo[] };
    }
  | {
      type: 'file';
      body: { text: string; files: FileInfo[] };
    }
  | {
      type: 'article';
      body: {
        imageMap: Record<string, ImageInfo>;
        fileMap: Record<string, FileInfo>;
        embedMap: Record<string, EmbedInfo>; // TODO embedMapの対応
        urlEmbedMap: Record<string, UrlEmbedInfo>;
        blocks: Block[];
      };
    }
  | {
      type: 'text';
      body: { text: string };
    }
  | {
      type: 'unknown';
      body: unknown;
    }
);

// articleタイプのマップ型に対する値の型
type ImageInfo = { originalUrl: string; extension: string };
type FileInfo = { url: string; name: string; extension: string };
type EmbedInfo = unknown; // FIXME
type UrlEmbedInfo = { id: string } & (
  | { type: 'default'; url: string; host: string }
  | { type: 'html'; html: string }
  | { type: 'html.card'; html: string }
  | {
      type: 'fanbox.post';
      postInfo: { id: string; title: string; creatorId: string; coverImageUrl?: string };
    }
  | { type: 'unknown'; [key: string]: unknown }
); // 他の型がありそうなので入れてる

// articleタイプのBlock構成要素
type ImageBlock = { type: 'image'; imageId: string };
type FileBlock = { type: 'file'; fileId: string };
type TextBlock = { type: 'p' | 'header'; text: string };
type EmbedBlock = { type: 'embed'; embedId: string };
type UrlEmbedBlock = { type: 'url_embed'; urlEmbedId: string };
type UnknownBlock = { type: 'unknown' }; // 他の型がありそうなので入れてる default句で使ってるのでコンパイルすると型が消えて他のを除いた全部に対応する
type Block = ImageBlock | FileBlock | TextBlock | EmbedBlock | UrlEmbedBlock | UnknownBlock;
