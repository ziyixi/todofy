# Lab / Paper Radar: the daily deck (UX)

The owner's ask (2026-09-30): read a short Chinese 简介 of each paper, swipe right for 喜欢 or left for
不喜欢, have the likes recorded, and after the last card confirm whether to send them to Todofy, with a
way to redo; "非常 user friendly", learning from good implementations. This file is the research and
the concrete interaction spec the web build follows. Data model and API: [`design.md`](design.md) §7–§9.

## 1. What good implementations do (research, 2026-09-30)

| Product | What makes it pleasant | Adopt |
| --- | --- | --- |
| **Scholar Inbox** (daily ranked arXiv digest; paper [arXiv:2504.08385](https://arxiv.org/abs/2504.08385)) | Mobile-first cards with a flat hierarchy; each card has title, authors, abstract, a relevance colour and a highlighted "most related" sentence; explicit thumbs up/down retrain the model after each rating; onboarding asks for a few known papers, then active learning; a catch-up digest after an absence. | Binary rating that visibly feeds ranking; a **"为什么推荐" line** (the liked/seed paper this card is closest to); cold start from a handful of seeds **or** from swiping a first exploratory deck; an "older deck still open" nudge instead of piling days together. |
| **Semantic Scholar Research Feeds** ([FAQ](https://www.semanticscholar.org/faq/research-feeds-signaling)) | Positive signal = save to library, negative = "not relevant"; the feed updates at the next refresh; tells users how much signal is enough ("rate 5 relevant and 3 non-relevant"). | Say plainly what a swipe does ("喜欢会让相似论文排得更靠前"), and give the cold-start target as a number ("再喜欢 3 篇，推荐就会个性化"). Changes apply at the next daily ranking, and the UI says so. |
| **arxiv-sanity-lite** ([repo](https://github.com/karpathy/arxiv-sanity-lite)) | One daily list ranked per interest from the user's own tags (SVM over tf-idf); fast, keyboard-friendly, no chrome. | Keep the list calm and fast; ranking explanation stays simple; keyboard is first-class on desktop. |
| **PaperCrush** (arXiv swipe app, [listing](https://mwm.ai/apps/papercrush/6745439518)) and **PaiperSwipe** ([Product Hunt](https://www.producthunt.com/products/paiperswipe)) | Tinder-style like/skip over new arXiv papers; a plain-language or translated summary on the card so a decision takes seconds; a saved list with read state; full abstract and PDF one tap away. | The card's main text is the **Chinese 简介**, not the English abstract; abstract is a disclosure; a **已喜欢** list outside the deck. |
| **react-tinder-card** ([README](https://cdn.jsdelivr.net/npm/react-tinder-card@1.6.4/readme.md)) and swipe-physics write-ups ([example](https://vp0.com/blogs/tinder-card-swipe-animation-react-native-reanimated-free-ios-template-vibe-codin.md)) | Commit on distance **or** velocity; a stamp whose opacity follows the drag; ~12° tilt at the edge; the exit keeps the finger's speed; below the threshold the card springs back at no cost; programmatic `swipe(dir)` for buttons and `restoreCard()` for undo. | Exactly these mechanics, implemented with pointer events and CSS transforms (no library): §3. |
| **Tinder "Rewind"**, as analysed by [Deceptive Design](https://deceptive.design/articles/tinder-pay-to-undo) | A paywalled one-step undo exploits mis-swipes. | The anti-pattern: undo is **free, unlimited and always visible**, back to the first card. |
| **Gmail undo send** ([Google](https://blog.google/products/gmail/how-to-unsend-email-gmail/)) | Act immediately, offer "Undo" in a snackbar for 5–30 s instead of asking "are you sure?". | Swipes never ask for confirmation; a 5 s snackbar "已喜欢 · 撤销" plus the permanent undo button. The **only** confirmation is the external side effect (sending to Todofy). "重来" is undoable the same way. |
| **WCAG 2.2** ([2.5.7 Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html), [2.5.8 Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)) | Everything a drag does must also work with a single tap; targets ≥ 24 px (Apple HIG recommends 44 pt). | Real 喜欢/不喜欢/撤销 buttons (≥ 48 px, the two main ones 64 px); keyboard equivalents; live-region announcements. |

Platform references for the implementation: MDN [`touch-action`](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action),
[`setPointerCapture`](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture),
[`prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion).

## 2. Flow

```
今日 ──► [empty: 第一批论文还在路上]           (no deck yet)
      ├► [deck: one card at a time] ──last card──► [summary + 发送到 Todofy？] ──► [done for today]
      └► [done for today]                       (newest deck finished; summary and send state)
```

- **Deck** = the ranked cards (≤ 20) of one arXiv announcement day, frozen when ranked. Opening the app
  lands on the first undecided card of the newest deck. Leaving and coming back resumes there (server
  state, any device).
- **Cold start**: with no seeds and no likes the day's deck is an **探索** deck (20 new papers spread over
  the categories) with a one-line banner "还没有种子：先凭直觉划一组，你的喜欢就是推荐的起点 · 添加种子". Its
  likes feed tomorrow's ranking like any other.
- **Older unfinished deck**: a quiet chip on the done/empty screens, "9月29日 还剩 8 篇", never mixed into
  today's deck. Decks older than 7 days are not offered (their likes stay).

## 3. The card and the gestures

**Anatomy** (top to bottom, one scrollable card; the action bar stays fixed below it):

1. Meta row: `#3` rank, primary category chip (`cs.IR`), `交叉` chip for cross-lists, and on explore
   decks `探索`. No raw scores.
2. Title: 19 px / 1.35, up to 4 lines, `lang="en"`.
3. Authors: one line, "A. Author, B. Author 等 7 人".
4. **简介** block, the visual centre: 17 px / 1.75, `lang="zh-CN"`, 2–4 sentences, generated only from the
   abstract. Under it, a small grey label "AI 根据摘要生成". If the 简介 is missing (cap hit, model error):
   the first two sentences of the abstract with the label "原文摘要节选".
5. 为什么推荐: "与你喜欢的《…》相近" (the nearest liked/seed paper), one line, omitted on explore decks.
6. Disclosure button "展开原文摘要" (`aria-expanded`); the English abstract appears inline, 15 px / 1.6.
7. Links: `arXiv` and `PDF` buttons (`target="_blank" rel="noopener noreferrer"`), built from the ID only.

Behind the top card, the next two cards peek (scale 0.96 and 0.92, offset 8 px / 16 px) so the stack is
legible; only the top card is interactive (`inert` on the others).

**Drag** (pointer events on the top card, no library):

- `touch-action: pan-y` on the card so vertical scrolling of a long abstract keeps working; the drag
  starts only after 8 px of movement with |dx| > |dy| (direction lock), then `setPointerCapture`.
  Drags starting on a link or button are ignored.
- While dragging: `transform: translate3d(dx, dy·0.15, 0) rotate(clamp(dx / width · 12°, −12°, 12°))`,
  updated in `requestAnimationFrame`. A stamp fades in from the leading edge: right = green "喜欢" (top
  left of the card, −12°), left = grey-red "不喜欢" (top right, +12°); opacity = clamp(|dx| / threshold,
  0, 1). The matching action button highlights at the same time.
- Commit when |dx| ≥ **threshold = clamp(30 % of card width, 96 px, 160 px)**, or on a flick: release
  velocity ≥ **0.5 px/ms** with |dx| ≥ 40 px in the same direction. Otherwise spring back
  (220 ms, `cubic-bezier(.2,.8,.2,1)`).
- Exit: continue along the release vector to 1.2 × viewport width in 200–280 ms (faster flicks leave
  faster); the next card settles to scale 1 in 180 ms. Buttons and keys play the same exit, so every
  path looks the same.
- `prefers-reduced-motion: reduce`: no tilt, fly-out or spring; the card cross-fades (120 ms) and the
  stamp shows as a static badge for 300 ms.
- Optional `navigator.vibrate(8)` on commit where supported, never under reduced motion.

**Buttons** (bottom bar, thumb reach, safe-area inset): `撤销` (48 px, left, disabled only when there is
nothing to undo), `不喜欢` (64 px round, ThumbsDown icon + text), `喜欢` (64 px round, ThumbsUp icon + text,
primary colour). Desktop shows key hints under them (`←`, `→`, `Z`).

**Keyboard** (ignored while focus is in a text field; Space/Enter on a focused button keep their
native meaning): `→` or `L` 喜欢, `←` or `H` 不喜欢, `Space`/`Enter` 展开/收起摘要, `Z`, `⌘Z` or `Ctrl+Z`
撤销, `O` open arXiv, `?` shortcuts sheet, `Esc` close sheet.

**Progress**: a thin segmented bar at the top (one segment per card: filled green for 喜欢, grey for
不喜欢, outlined for the current) and the text "7 / 20 · 已喜欢 3". It doubles as a map of the deck.

## 4. Undo and 重来

- **撤销** pops the latest action, any number of times, back to the first card: the card flies back in
  from the side it left (reduced motion: fades in) and becomes the top card again. The snackbar after
  each swipe ("已喜欢《短标题…》 · 撤销", 5 s, one at a time) is a shortcut to the same action.
- **重来** ("回到卡片重来", on the summary and in the deck's menu) clears this deck's decisions and returns
  to card 1. No dialog: the snackbar "已清空 12 个选择 · 撤销" (8 s) restores them, and 撤销 later does too
  (the restart is itself an entry on the undo stack).
- Swipes are optimistic: the UI moves on at once and sends a queue of operations (each with an `op_id`
  and the deck `version` it saw). A failed operation rolls the card back with "网络异常，已恢复这张卡片" and
  keeps the rest of the queue; a version conflict (another tab or device) reloads the deck state
  silently and says "已同步其他设备上的选择".

## 5. End of deck: summary and the send step

After the last card: a 600 ms "看完了" moment (reduced motion: none), then the summary.

- Header: "20 篇看完了 · 喜欢 5 · 不喜欢 15".
- **Liked list** in deck order: title, the 简介's first sentence, and a `移出` button per row
  (removes it from **this send** only, the like stays; the row turns grey with `恢复`). Tapping a row
  reopens that card read-only.
- **Mode** (segmented control, remembered in settings): "一个父任务 + 子任务" (default) · "每篇单独一条".
  Live preview under it: "将在 Todoist 创建「论文雷达 2026-09-30 · 5 篇」和 5 个子任务" or "将创建 5 个任务".
- Actions: primary **发送到 Todofy** · secondary **暂不发送** (goes to the done screen; can send later from
  there) · tertiary **回到卡片重来**. With 0 likes: "今天没有喜欢的论文" and only 完成 / 回到卡片重来.
- Send states (one status line under the button, `aria-live="polite"`):

| State | Copy | Actions |
| --- | --- | --- |
| sending | 正在发送… | none (button busy) |
| pending | Todofy 正在创建：3 / 6 | none; polls every 3 s while visible |
| created | 已发送：Todoist 里新增了 6 个任务 | 完成 |
| duplicate | 这组已经发送过，不会重复创建 | 完成 |
| paused (not recorded) | Todofy 暂停中（Todoist 已暂停 / 维护中…），这次没有发送 | 稍后重试 |
| paused (recorded) | 已交给 Todofy，等它恢复后会自动创建 | 完成 |
| failed | 部分失败：已创建 4 / 6 | 重试（不会重复创建） |
| rejected | 没有发送：原因（今天发送次数已达上限 …） | 返回 |
| unknown | 结果未知：重试不会重复创建 | 重试 |

- Once a send exists, its content is frozen: the list shows "已发送" badges and mode is locked. If the
  owner later likes more papers in this deck (undo/重来 after sending), the summary offers
  **补发新增的 2 篇** as a second, separate send; papers already sent are never sent again.

## 6. Other states

- **Empty (before the first fetch)**: "第一批论文还在路上" + "下次抓取：<时间>" (next_run_at in the browser's time zone, e.g. "今晚 23:30") + "先添加几篇
  你喜欢的论文作为种子" (link to 种子). Status text only, no spinner.
- **Building** (fetch done, ranking or 简介 running): "今天的论文正在准备（排序 / 生成简介）…" with the phase;
  refetch every 30 s while visible.
- **Done for today**: "今天的 20 篇都看完了" + the send state line + "下一批：<时间>左右" (browser time zone) + links
  已喜欢 · 种子 · 设置, and the older-deck chip if any. Weekends: "arXiv 周末不发布，周一见".
- **Paused / cap hit / feed error**: one calm banner on top ("今日 AI 额度已用完，简介明天补上"), never a
  blocking error when cards exist.
- **已喜欢**: newest first, 50 per page, search box over titles, each row with arXiv/PDF links and
  `取消喜欢`.
- **种子**: paste arXiv IDs or URLs (one per line, ≤ 50), state per seed (解析中 / 已添加 / 未找到), counter
  "有 3 篇种子，推荐已个性化" or "再添加 2 篇效果更好".
- **设置**: categories, TL;DR model, daily neuron cap (only lower), default send mode, λ (advanced).

## 7. Accessibility and layout

- Every drag has a button and a key; buttons have visible text (icons are decorative) and ≥ 48 px
  targets, the two main ones 64 px; focus rings always visible.
- The top card is a `<article aria-roledescription="论文卡片" aria-labelledby=title>`; after each decision
  focus moves to the new top card's title (`tabindex="-1"`) and a polite live region says
  "已喜欢。第 8 篇，共 20 篇：<title>". Undo announces "已撤销：<title>".
- Layout: one column, `100dvh`, card max width 560 px centred on desktop, action bar fixed with
  `env(safe-area-inset-bottom)`; text sizes in rem; Chinese text never justified; contrast ≥ 4.5:1 in
  light and dark (`prefers-color-scheme`), the dashboard's calm tokens.
- No external fonts, images or network: system font stack (`-apple-system, "PingFang SC",
  "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`), lucide icons bundled, links to arxiv.org only.
- All text from arXiv and the model is rendered as plain text (React text nodes), never HTML.

## 8. Acceptance checks for the web build

Unit (Vitest + Testing Library, fixtures only): swipe threshold and flick maths on a pure function;
keyboard map; op queue (optimistic apply, rollback, version conflict); undo across a restart; summary
exclusions and preview copy for both modes; every send state's copy and actions; reduced-motion path;
live-region text. Manual (recorded in `docs/verification.md` later): phone Safari and Chrome with touch,
desktop keyboard-only, VoiceOver, dark mode.
