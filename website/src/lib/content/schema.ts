import { z } from "zod";

import { parseContentDate } from "./date";
import { validateKatexExpression } from "./equation";
import { validateLiteralRedirectSource } from "./redirect-path";
import { validateSlug } from "./slug";
import { validateHttpsOrigin, validatePublicHref } from "./url";

export const CONTENT_SCHEMA_VERSION = 1 as const;
export const MANIFEST_VERSION = 2 as const;
export const REGISTRY_VERSION = 1 as const;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SafeIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const NormalizedDateSchema = z.string().refine(
  (value) => {
    try {
      return parseContentDate(value) === value;
    } catch {
      return false;
    }
  },
  { message: "Expected a normalized UTC date-time." },
);

export const BlogSourceSchema = z.enum(["empty", "notion"]);
export const ContentSourceModeSchema = z.enum(["empty", "fixture", "notion"]);
export const LanguageSchema = z.enum(["en", "zh-CN"]);

export const SiteConfigSchema = z
  .object({
    canonicalOrigin: z.string().transform(validateHttpsOrigin),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(320),
    defaultLanguage: LanguageSchema,
    blogSource: BlogSourceSchema,
    homePostLimit: z.literal(3),
    featuredPublicationIds: z.array(z.string().trim().min(1)).max(10),
    notion: z
      .object({
        apiVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        propertyNames: z
          .object({
            title: z.string().min(1),
            slug: z.string().min(1),
            status: z.string().min(1),
            publishedAt: z.string().min(1),
            summary: z.string().min(1),
            language: z.string().min(1),
            tags: z.string().min(1),
            translationKey: z.string().min(1).optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type SiteConfigData = z.infer<typeof SiteConfigSchema>;

export const ProfileLinkSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    url: z.string().transform(validatePublicHref),
  })
  .strict();

export const ProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    bioParagraphs: z.array(z.string().trim().min(1).max(2_000)).min(1),
    portrait: z
      .object({
        src: z.string().regex(/^\/profile\/[A-Za-z0-9._-]+$/),
        alt: z.string().trim().min(1).max(240),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict(),
    links: z.array(ProfileLinkSchema),
    cvPath: z.literal("/cv.pdf").optional(),
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;

export const PublicationAuthorSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    siteOwner: z.boolean().optional(),
  })
  .strict();

export const PublicationLinkSchema = z
  .object({
    label: z.enum(["DOI", "Publisher", "PDF", "Code", "BibTeX"]),
    url: z.string().transform(validatePublicHref),
  })
  .strict();

export const PublicationSchema = z
  .object({
    id: SafeIdSchema,
    title: z.string().trim().min(1).max(500),
    authors: z.array(PublicationAuthorSchema).min(1),
    venue: z.string().trim().min(1).max(240),
    year: z.number().int().min(1900).max(2200),
    volume: z.string().trim().min(1).max(40).optional(),
    issue: z.string().trim().min(1).max(40).optional(),
    pages: z.string().trim().min(1).max(40).optional(),
    doi: z
      .string()
      .regex(/^10\.\d{4,9}\/\S+$/i)
      .optional(),
    links: z.array(PublicationLinkSchema),
    homeAuthors: z.string().trim().min(1).max(240),
    featuredOrder: z.number().int().nonnegative().optional(),
    orderWithinYear: z.number().int().nonnegative().default(0),
  })
  .strict()
  .superRefine((publication, context) => {
    if (!publication.doi && publication.links.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A publication without a DOI must provide at least one resource link.",
      });
    }
  });

export type Publication = z.infer<typeof PublicationSchema>;

export const PublicationsFileSchema = z
  .object({ publications: z.array(PublicationSchema) })
  .strict();

export const RedirectConfigSchema = z
  .object({
    from: z.string().transform(validateLiteralRedirectSource),
    to: z
      .string()
      .transform(validatePublicHref)
      .refine((value) => value.startsWith("/"), { message: "Redirect targets must be internal." })
      .optional(),
    targetPostKey: Sha256Schema.optional(),
  })
  .strict()
  .superRefine((redirect, context) => {
    if ((redirect.to ? 1 : 0) + (redirect.targetPostKey ? 1 : 0) !== 1) {
      context.addIssue({
        code: "custom",
        message: "A redirect must specify exactly one of to or targetPostKey.",
      });
    }
  });

export type RedirectConfig = z.infer<typeof RedirectConfigSchema>;
export const RedirectsFileSchema = z.array(RedirectConfigSchema);

export const RichTextSpanSchema = z
  .object({
    text: z.string(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    underline: z.boolean().optional(),
    code: z.boolean().optional(),
    equation: z.boolean().optional(),
    href: z.string().transform(validatePublicHref).optional(),
  })
  .strict()
  .transform((span) => {
    if (span.equation) validateKatexExpression(span.text, false);
    return span;
  });

export type RichTextSpan = z.infer<typeof RichTextSpanSchema>;

interface BaseBlock {
  id: string;
  type: string;
}

export interface ParagraphBlock extends BaseBlock {
  type: "paragraph";
  richText: RichTextSpan[];
  children: ContentBlock[];
}

export interface HeadingBlock extends BaseBlock {
  type: "heading";
  level: 2 | 3 | 4;
  anchor: string;
  richText: RichTextSpan[];
  toggleable?: boolean;
  children?: ContentBlock[];
}

export interface ToDoBlock extends BaseBlock {
  type: "toDo";
  checked: boolean;
  richText: RichTextSpan[];
  children: ContentBlock[];
}

export interface Column {
  id: string;
  widthRatio?: number;
  children: ContentBlock[];
}

export interface ColumnsBlock extends BaseBlock {
  type: "columns";
  columns: Column[];
}

export interface TableOfContentsBlock extends BaseBlock {
  type: "tableOfContents";
}

export interface ListItemBlock extends BaseBlock {
  type: "listItem";
  style: "bulleted" | "numbered";
  richText: RichTextSpan[];
  children: ContentBlock[];
}

export interface QuoteBlock extends BaseBlock {
  type: "quote";
  richText: RichTextSpan[];
  children: ContentBlock[];
}

export interface DividerBlock extends BaseBlock {
  type: "divider";
}

export interface CodeBlock extends BaseBlock {
  type: "code";
  code: string;
  language: string;
  caption: RichTextSpan[];
  highlighted: boolean;
}

export interface EquationBlock extends BaseBlock {
  type: "equation";
  expression: string;
}

export interface ImageBlock extends BaseBlock {
  type: "image";
  mediaPath: string;
  sha256: string;
  width: number;
  height: number;
  alt: string;
  caption: RichTextSpan[];
}

export interface MediaFileBlock extends BaseBlock {
  type: "mediaFile";
  kind: "file" | "pdf" | "audio" | "video";
  name: string;
  caption: RichTextSpan[];
  source: { type: "local"; mediaPath: string; sha256: string } | { type: "external"; href: string };
}

export interface EmbedBlock extends BaseBlock {
  type: "embed";
  href: string;
  caption: RichTextSpan[];
}

export interface TableBlock extends BaseBlock {
  type: "table";
  hasColumnHeader: boolean;
  hasRowHeader: boolean;
  rows: RichTextSpan[][][];
}

export interface ToggleBlock extends BaseBlock {
  type: "toggle";
  richText: RichTextSpan[];
  children: ContentBlock[];
}

export interface CalloutBlock extends BaseBlock {
  type: "callout";
  richText: RichTextSpan[];
  icon?: string;
  children: ContentBlock[];
}

export interface BookmarkBlock extends BaseBlock {
  type: "bookmark";
  href: string;
  caption: RichTextSpan[];
}

export type ContentBlock =
  | ParagraphBlock
  | HeadingBlock
  | ToDoBlock
  | ColumnsBlock
  | TableOfContentsBlock
  | ListItemBlock
  | QuoteBlock
  | DividerBlock
  | CodeBlock
  | EquationBlock
  | ImageBlock
  | MediaFileBlock
  | EmbedBlock
  | TableBlock
  | ToggleBlock
  | CalloutBlock
  | BookmarkBlock;

const children = () => z.array(ContentBlockSchema);

export const ContentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("paragraph"),
        richText: z.array(RichTextSpanSchema),
        children: children(),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("heading"),
        level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
        anchor: SafeIdSchema,
        richText: z.array(RichTextSpanSchema).min(1),
        toggleable: z.boolean().optional(),
        children: children().optional(),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("toDo"),
        checked: z.boolean(),
        richText: z.array(RichTextSpanSchema),
        children: children(),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("columns"),
        columns: z
          .array(
            z
              .object({
                id: SafeIdSchema,
                widthRatio: z.number().finite().positive().max(1).optional(),
                children: children(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    z.object({ id: SafeIdSchema, type: z.literal("tableOfContents") }).strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("listItem"),
        style: z.enum(["bulleted", "numbered"]),
        richText: z.array(RichTextSpanSchema),
        children: children(),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("quote"),
        richText: z.array(RichTextSpanSchema),
        children: children(),
      })
      .strict(),
    z.object({ id: SafeIdSchema, type: z.literal("divider") }).strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("code"),
        code: z.string(),
        language: z.string().trim().min(1).max(80),
        caption: z.array(RichTextSpanSchema),
        highlighted: z.boolean(),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("equation"),
        expression: z.string().transform((expression) => validateKatexExpression(expression, true)),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("image"),
        mediaPath: z.string().regex(/^\/media\/[a-f0-9]{64}\.[a-z0-9]+$/),
        sha256: Sha256Schema,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        alt: z.string().max(500),
        caption: z.array(RichTextSpanSchema),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("mediaFile"),
        kind: z.enum(["file", "pdf", "audio", "video"]),
        name: z.string().trim().min(1).max(200),
        caption: z.array(RichTextSpanSchema),
        source: z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("local"),
              mediaPath: z.string().regex(/^\/media\/[a-f0-9]{64}\.[a-z0-9]+$/),
              sha256: Sha256Schema,
            })
            .strict(),
          z
            .object({
              type: z.literal("external"),
              href: z.string().transform(validatePublicHref),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("embed"),
        href: z.string().transform(validatePublicHref),
        caption: z.array(RichTextSpanSchema),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("table"),
        hasColumnHeader: z.boolean(),
        hasRowHeader: z.boolean(),
        rows: z.array(z.array(z.array(RichTextSpanSchema))).min(1),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("toggle"),
        richText: z.array(RichTextSpanSchema),
        children: children(),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("callout"),
        richText: z.array(RichTextSpanSchema),
        icon: z.string().max(20).optional(),
        children: children(),
      })
      .strict(),
    z
      .object({
        id: SafeIdSchema,
        type: z.literal("bookmark"),
        href: z.string().transform(validatePublicHref),
        caption: z.array(RichTextSpanSchema),
      })
      .strict(),
  ]),
);

export const TocEntrySchema = z
  .object({
    id: SafeIdSchema,
    text: z.string().trim().min(1),
    level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  })
  .strict();

export const PostSchema = z
  .object({
    sourceKey: Sha256Schema,
    feedGuid: z.string().regex(/^urn:ziyixi:post:[a-f0-9]{64}$/),
    slug: z.string().transform(validateSlug),
    title: z.string().trim().min(1).max(300),
    summary: z.string().trim().min(1).max(600),
    language: LanguageSchema,
    translationKey: z.string().trim().min(1).optional(),
    publishedAt: NormalizedDateSchema,
    updatedAt: NormalizedDateSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(80)),
    blocks: z.array(ContentBlockSchema),
    toc: z.array(TocEntrySchema),
    media: z.array(z.string().regex(/^\/media\/[a-f0-9]{64}\.[a-z0-9]+$/)),
  })
  .strict()
  .superRefine((post, context) => {
    if (post.feedGuid !== `urn:ziyixi:post:${post.sourceKey}`) {
      context.addIssue({ code: "custom", message: "feedGuid must be derived from sourceKey." });
    }
    if (post.updatedAt && post.updatedAt < post.publishedAt) {
      context.addIssue({ code: "custom", message: "updatedAt cannot precede publishedAt." });
    }
  });

export type Post = z.infer<typeof PostSchema>;

export const MediaAssetSchema = z
  .object({
    path: z.string().regex(/^\/media\/[a-f0-9]{64}\.[a-z0-9]+$/),
    sha256: Sha256Schema,
    mimeType: z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
    sizeBytes: z.number().int().nonnegative(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();

export const SnapshotRedirectSchema = z
  .object({
    from: z.string().transform(validateLiteralRedirectSource),
    to: z
      .string()
      .transform(validatePublicHref)
      .refine((value) => value.startsWith("/"), { message: "Redirect targets must be internal." }),
    status: z.literal(308),
    sourceKey: Sha256Schema.optional(),
  })
  .strict();

export type SnapshotRedirect = z.infer<typeof SnapshotRedirectSchema>;

export const ContentSnapshotSchema = z
  .object({
    schemaVersion: z.literal(CONTENT_SCHEMA_VERSION),
    sourceMode: ContentSourceModeSchema,
    posts: z.array(PostSchema),
    media: z.array(MediaAssetSchema),
    redirects: z.array(SnapshotRedirectSchema),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.sourceMode === "empty" && snapshot.posts.length !== 0) {
      context.addIssue({ code: "custom", message: "empty mode cannot contain posts." });
    }
    const slugs = new Set<string>();
    const keys = new Set<string>();
    for (const post of snapshot.posts) {
      if (slugs.has(post.slug)) {
        context.addIssue({ code: "custom", message: `Duplicate slug: ${post.slug}` });
      }
      if (keys.has(post.sourceKey)) {
        context.addIssue({ code: "custom", message: `Duplicate sourceKey: ${post.sourceKey}` });
      }
      slugs.add(post.slug);
      keys.add(post.sourceKey);
    }
  });

export type ContentSnapshot = z.infer<typeof ContentSnapshotSchema>;

export const RegistryPostSchema = z
  .object({
    sourceKey: Sha256Schema,
    currentSlug: z.string().transform(validateSlug),
    historicalSlugs: z.array(z.string().transform(validateSlug)),
    feedGuid: z.string().regex(/^urn:ziyixi:post:[a-f0-9]{64}$/),
    published: z.boolean(),
  })
  .strict();

export const ContentRegistrySchema = z
  .object({
    registryVersion: z.literal(REGISTRY_VERSION),
    articleCount: z.number().int().nonnegative(),
    posts: z.array(RegistryPostSchema),
  })
  .strict();

export type ContentRegistry = z.infer<typeof ContentRegistrySchema>;

export const ManifestRouteSchema = z
  .object({
    path: z.string().regex(/^\/(?!\/).*$/),
    expectedStatus: z.union([z.literal(200), z.literal(308), z.literal(404)]),
    kind: z.enum(["page", "post", "redirect", "feed", "asset", "absent"]),
    expectedLocation: z
      .string()
      .regex(/^\/(?!\/).*$/)
      .optional(),
    sha256: Sha256Schema.optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    mimeType: z
      .string()
      .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i)
      .optional(),
  })
  .strict()
  .superRefine((route, context) => {
    if (route.kind === "redirect") {
      if (route.expectedStatus !== 308 || !route.expectedLocation) {
        context.addIssue({
          code: "custom",
          message: "Redirect routes require status 308 and an expectedLocation.",
        });
      }
    } else {
      const expectedStatus = route.kind === "absent" ? 404 : 200;
      if (route.expectedStatus !== expectedStatus) {
        context.addIssue({
          code: "custom",
          message: `${route.kind} routes require status ${expectedStatus}.`,
        });
      }
      if (route.expectedLocation) {
        context.addIssue({
          code: "custom",
          message: "Only redirect routes may define expectedLocation.",
        });
      }
    }

    if (route.kind === "asset") {
      if (
        route.expectedStatus !== 200 ||
        !route.sha256 ||
        route.sizeBytes === undefined ||
        !route.mimeType
      ) {
        context.addIssue({
          code: "custom",
          message: "Asset routes require status 200, hash, byte length, and media type.",
        });
      }
    } else if (route.sha256 || route.sizeBytes !== undefined || route.mimeType) {
      context.addIssue({
        code: "custom",
        message: "Only asset routes may define media verification fields.",
      });
    }
  });

export const ContentManifestSchema = z
  .object({
    manifestVersion: z.literal(MANIFEST_VERSION),
    schemaVersion: z.literal(CONTENT_SCHEMA_VERSION),
    complete: z.literal(true),
    sourceMode: ContentSourceModeSchema,
    contentHash: Sha256Schema,
    configHash: Sha256Schema,
    snapshotFile: z.literal("snapshot.json"),
    completedAt: NormalizedDateSchema,
    postCount: z.number().int().nonnegative(),
    mediaCount: z.number().int().nonnegative(),
    routes: z.array(ManifestRouteSchema),
    candidateRegistry: ContentRegistrySchema,
    diagnostics: z
      .object({
        draftCount: z.number().int().nonnegative(),
        futureCount: z.number().int().nonnegative(),
        warnings: z.array(z.string()),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = new Set<string>();
    for (const route of manifest.routes) {
      if (paths.has(route.path)) {
        context.addIssue({
          code: "custom",
          message: `Manifest contains a duplicate route: ${route.path}`,
        });
      }
      paths.add(route.path);
    }
  });

export type ContentManifest = z.infer<typeof ContentManifestSchema>;
