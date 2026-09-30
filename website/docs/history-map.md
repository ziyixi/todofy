# Website commit map

The personal website (www.ziyixi.science) was developed in github.com/ziyixi/ziyixi.science until main `3343769`. Its 11 commits were imported into this monorepo with every path rewritten under `website/`, which gives each commit a new ID. File contents, authors, dates and messages are unchanged, so `git log --follow -- website/<file>` shows the original commits. Anything that cites an old ID still resolves in the old repository; this table maps them to the monorepo.

The imported `website/.github/workflows/` files are the old repository's Vercel-era workflows. GitHub Actions only runs workflows from the repository root, so they do not run here.

| ziyixi/ziyixi.science | monorepo | subject |
| --- | --- | --- |
| `3343769` | `7c3dab8` | Show per-article publication status in Notion |
| `1bfa5f6` | `5cde299` | Use Cloudflare-compatible redirect handling in publish relay |
| `11d4097` | `c775568` | Add authenticated Notion publish button relay |
| `c6083f8` | `cf322cd` | Refine mobile blog layout and Chinese article rhythm |
| `82d25f0` | `46692a8` | Use PhotoSwipe for article image enlargement |
| `f468aee` | `beb247b` | Reserve mobile image space before lazy loading |
| `64e82a2` | `4522679` | Enable article image zoom and more Notion blocks |
| `51cf748` | `c2d3596` | Require stable public identity throughout deployment verification |
| `219f930` | `8c2288e` | Wait for public build identity after promotion |
| `05be2e1` | `f567e51` | Fix recovery after an errored bootstrap deployment |
| `0a96280` | `a28c6a2` | Replace personal website with Notion-backed Next.js site |
