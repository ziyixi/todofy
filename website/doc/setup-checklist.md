# Notion content setup

The site reads one Blog data source through a read-only Notion connection. Publication, recovery and production
configuration are in [release](../docs/release.md). No public Notion page or publish button is required.

## Blog fields

One row is one article; its page body holds the article. Property names and types are case sensitive.

| Property         | Notion type  | Published article                                                    |
| ---------------- | ------------ | -------------------------------------------------------------------- |
| `Title`          | Title        | 1–300 characters                                                     |
| `Slug`           | Text         | 1–80 characters; lowercase letters, digits and single hyphens        |
| `Status`         | Status       | `Draft` or `Published`; unknown or empty values stop synchronization |
| `PublishedAt`    | Date         | Required; future articles stay unpublished                           |
| `Summary`        | Text         | 1–600 characters                                                     |
| `Language`       | Select       | `en` or `zh-CN`                                                      |
| `Tags`           | Multi-select | Property required; value may be empty                                |
| `TranslationKey` | Text         | Optional; same value joins translations                              |

Default new articles to Draft. The first seven properties must exist even when draft values are empty.
Translation pages have distinct slugs and one published page per language/key. The list groups them by the earliest
publication date, while RSS keeps one item per language. A date without a time means UTC midnight.

Slugs must be unique, including historical ownership; do not reassign an old slug to another article. Reserved routes
include `about`, `api`, `blog`, `build-info`, `cv`, `feed`, `publications`, `robots` and `sitemap`. The content registry
keeps slug redirects and feed identities across releases. A Notion view filter does not limit publication: the reader
validates the entire configured data source.

Only Published pages whose date has arrived appear. Explicit Draft or archived withdrawal is supported. A previously
non-empty collection becoming empty requires complete positive withdrawal evidence, or an explicit allow-empty
recovery; missing access or ambiguous identity stops the release. Daily sync or Home **立即同步** publishes later
changes. Saving a Notion page alone does not publish it immediately.

## Connection and local preview

Create a dedicated internal connection with Read content only, and grant it access to the original Blog database.
A linked view is insufficient when its underlying data source is inaccessible. Use the actual data source ID,
not the database, view or article ID. Keep the token in the normal local/production secret inputs.

From `website/`, after [workspace setup](../../docs/dependencies.md), put these names in ignored `.env.local`:

```dotenv
NOTION_TOKEN=<read-only connection token>
NOTION_DATA_SOURCE_ID=<Blog data source ID>
```

`make preview` loads that file, synchronizes a local snapshot and starts Next. `make sync` only synchronizes;
`make dev` opens the existing snapshot. Local synchronization uses its own registry; production takes its trusted
baseline from the release ledger. Do not commit snapshots, response bodies or `.env.local`.

Use `pnpm content:prepare:fixture` for synthetic content or `pnpm content:prepare:empty` for an explicit empty blog.
These modes need no Notion token and are never production fallbacks.

## Supported body and media

Paragraphs, H1–H3, rich text, nested lists, quotes, code, equations, images, simple tables, toggles, callouts and
bookmarks are supported. To-dos are read only; columns stack on narrow screens. Toggle headings preserve their level
and anchors. At most one top-level table-of-contents block selects the article's TOC location. Link previews become
ordinary safe links. Uploaded files, PDF, audio and video are captured as site assets; external embeds use supported
HTTPS players or ordinary links. Arbitrary HTML and scripts are not rendered.

Unknown blocks stop synchronization. Notion page links and mentions must resolve to an article public in that snapshot;
block-fragment links are unsupported. Ordinary links/bookmarks may use HTTP, HTTPS or mailto as applicable; media
fetches and canonical URLs require HTTPS.

Images support JPEG, PNG, WebP, AVIF and GIF, with a 20 MiB image cap. Attachments and videos have a 24 MiB cap;
all media shares the 200 MiB synchronization cap. Required media failures stop the snapshot. Add captions for useful
alt text. Download host rules and exact validation are defined in
[`scripts/content/notion/`](../scripts/content/notion/) and [`schema.ts`](../src/lib/content/schema.ts).
The [architecture](../docs/architecture.md#images) explains generated responsive images and export limits.
