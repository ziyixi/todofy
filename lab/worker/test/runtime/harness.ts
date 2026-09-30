/**
 * workerd harness (docs/design.md §10). Scaffold: the Miniflare setup (bundle src/index.ts with esbuild,
 * real D1 + LabState storage, a fake AI binding, an outbound handler that plays rss.arxiv.org and
 * export.arxiv.org) lands here. All data is synthetic; no network.
 */
export const LAB_TEST_HOST = 'lab.localhost';
