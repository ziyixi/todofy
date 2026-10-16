# Todoist Plus 验收

## 本地检查

2026-10-13 的交互修正工作树已通过：TypeScript、ESLint、35 个单元／交互／API 检查、生产构建，以及 9 个实际 MV3 Chromium 浏览器检查。发布 SHA 和真实账户验收由根 HANDOFF 单独记录。

- React 交互、计划派生和根 proto HTTP 客户端使用合成数据验证：父子任务计数、提醒保留、一次调整承诺、停止与真正完成的区别、完成重试身份、字段掩码、未知估时、跨午夜计时。
- `test:browser` 加载 `.output/chrome-mv3` 实际构建包，在新建的临时 Chromium profile 运行；页面为合成 Todoist DOM，服务端通过 background 内的独立假响应提供。不访问真实任务或个人浏览器 profile。
- 浏览器检查覆盖侧栏挂载、原生页面恢复、旧筛选器隐藏、background API 调用、失败完成保持可见并以相同 ID 重试、计时冲突刷新、FlowDay 本地与杂项条目、任务详情父子 ID、暗色主题和语言，以及映射失效／连接失效后恢复旧控件。

构建包测试曾实际捕获 WXT 默认 host reset 导致隐藏和主题无效的问题；挂载点已明确开启样式继承，并保留相应回归。

## 上线验收

发布成功、真实 Todoist 的视觉融合、PWA、键盘输入、真实 Todoist 任务写入与下一次自然周重置须分别记录。上述合成测试不能代替这些结果；当前生产验收由根 HANDOFF 记录。

## 安装后审查与周规划修正

2026-10-13 在 owner 已连接的真实 Chrome 中检查原生 Today、Plan、Focus 和 FlowDay。确认了平铺步骤、双重导航高亮、宽松布局及过多技术收藏的问题。FlowDay 的 Todoist key 在原迁移中未带入；通过正规 owner 设置恢复原有只读连接，看到 key saved、Sync complete 和更新后的同步时间。密钥未写入扩展、代码、文档或日志。

新一版用合成数据在 Chrome 检查周看板与 Focus。原型残留的 800px 样式覆盖已移除；实际构建包的日列宽度和无横向溢出也由浏览器检查验证。没有新增浏览器测试框架。

- 真实打包扩展：拖入空日、跨日移动、指定位置插入、同日排序及刷新后的保存结果；只写 FlowDay 队列，保留其他本地记录和 Todoist 日期。
- Focus：父任务路径、按时长卡片、键盘排序；切换日期保留已有计时，非今天不能开始新计时。
- 原生集成：选中与 hover、导航恢复、真实形状的收藏包装、Other views 展开，以及连接失败后恢复。
- 本地 D1：新增跨日绑定通路通过；同日 rollover 的旧行为先被回归测出，再验证拒绝且零写入。

周规划版本 `ba149ec` 已通过分支 CI 38503430909 和同 SHA main 发布 38504086473；FlowDay、Todofy 和扩展发布成功，其他应用未发布。

真实账户中创建一个明确标记的合成父任务和两个 30 分钟步骤。已验证批量拆分、加入今天、Focus 完成步骤及 Todoist 中的完成状态；随后完成父任务与剩余步骤，Inbox 不再留下测试任务，未启动计时。返回 Focus 时曾显示旧队列，人工刷新才出现新步骤；根因是进入原生页面后 App 仍隐藏存活。现在只在离开自定义页面时卸载，返回后重新读取；Plan 与 Focus 切换保留选中日期。对应浏览器回归先在旧构建失败，再在修复后通过，已加入今天的按钮也改为禁用的确认标记。

此处真实任务操作使用 owner 当前安装的版本，不能代替新目录中新构建的实测。后续修复发布、Documents 下的新安装目录、owner 更新后的拖动和 PWA 仍需逐项记录。

## 已安装版本反馈后的修正

本次真实 Chrome 检查先遇到旧脚本失效而未刷新，刷新后才加载周看板。合成父任务与两个 30 分钟步骤验证了实际日列拖动及持久结果；界面确认滞后，不能用落下后的瞬间读数判定失败。随后移出测试排程、完成父任务与子步骤，并重新加载 Inbox 核对没有活动测试任务。未操作真实计时。

当前修正将排程和计时采用已确认的服务端响应，切换 Plan／Focus 不重读全部数据；排程之后只核对显示周的队列。Focus 只执行今天的安排，估时编辑归入步骤详情。父任务不注册拖动节点，展开和详情不再受库写入的禁用祖先影响；构建包测试先测出旧包失败，再验证修复。父子色标、较清晰字体、三日／单日响应式和切周已在实际 Chrome 的纯合成预览中检查，未宣称新包已在真实账户加载。

回归检查覆盖已确认队列不触发全量任务扫描、源日和完成记录保留、计时确认及停止清空、Plan 到 Focus 的一致执行顺序、父任务与暂停步骤的可操作性、换周保存、窄窗口无横向溢出、迟到读取不覆盖新视图，以及估时保存与清空。没有新增故障矩阵、浏览器框架、生产诊断或重试机制。

Plan／Focus 导航图形缩至 18px，保留原生的 24px 布局槽和文字起点，构建包检查核对尺寸。发布与同目录更新后，还需真实新版响应与 PWA 验收；自然周重置仍是独立待验项。

## 当前规划界面（2026-10-14）

已批准的 Review／Week 原型接入正式扩展。Bets 使用真实任务标记表示本周整体目标，位于四列看板上方；Focus 直接执行今日队列，不提供第二套排程或排序界面。上文的卡片按时长拉高与 Focus 键盘排序属于旧版验收，不是当前设计。

[规划界面与接口说明](planning-interface.md)记录当前行为、各组件责任和正式组件的合成截图。该预览使用 `design/production.html`，直接渲染生产 `src/App`；旧 `design/index.html` 保留原型对照。截图和临时 MV3 测试均不包含私人任务。生产发布、同目录安装和仍待真实账户验收的部分见根 [验收记录](../../docs/todoist-plus-verification.md)。

## 主题、恢复与界面细节（2026-10-15，本地）

owner 批准的安全（C1–C6）、主题（A1–A6）和细节（B1–B6）已在本地分支完成，未推送、无分支 CI 或发布。全部使用合成数据和公开主题 CSS，未打开真实 Todoist。

- 单元／交互：jsdom 驱动 `mountTodoist` 与合成页面，覆盖重建 `#content` 和侧栏后重新挂载、挂载被拒后恢复、Todoist 对话框保持可见、停用扩展立即恢复、渲染出错的一行回退与切换视图后重试、重建次数上限及其后的点击恢复、观察循环上限（Plus 与页面互相改动时卸下，Todoist 自身持续变化时不卸下）、计划读取失败时其他收藏保持可见、后台标签页的启动检测、深色后备；任务详情的面包屑、小步骤列表与链接不一致；锚点表顺序；页面检测的固定键与拒绝未知键；token 名检查（含运行时拼接的名称和 `--td-ui-*`）。
- 实际 MV3 构建包：任务工具不绑定面包屑或链接不符的任务，设置页说明原因；重建内容区和侧栏后 Plan／Focus 恢复；九个公开主题只靠 CSS 切换且 `--plus-*` 等于对应 token，Plus 组合的文字对比度至少 4.5:1、线条至少 3:1，Week 中今天的数字和选中事项的次要文字实测通过；Dark 不带 color-scheme 时宿主仍为深色；无 token 时浅色／深色后备；侧栏收起后计时条仍居中。其中 Dark 和深色后备的部分已于 2026-10-16 随深色模式删除，见下文。

### 发布前页面核对

同一 SHA 发布前，owner 在真实 Todoist 的 DevTools 控制台运行下面两行只读脚本，把结果记入根验收记录后再发布。它们只返回主题类名、CSS 值、布尔值和像素差，不读取任务内容。

1. 主题，在 Today 等原生页面上，Kale 中一次：

   ```
   (()=>{const h=document.documentElement,s=getComputedStyle(h),v=n=>s.getPropertyValue('--product-library-'+n).trim()||null,side=document.querySelector('[data-testid=app-sidebar-scrollable-container]'),nav=document.querySelector('todoist-plus-navigation'),rgb=c=>{const e=document.body.appendChild(document.createElement('i'));e.style.color=c;const r=getComputedStyle(e).color;e.remove();return r},left=e=>{const t=e&&document.createTreeWalker(e,NodeFilter.SHOW_TEXT).nextNode(),r=t&&document.createRange();if(!r)return null;r.selectNodeContents(t);return Math.round(r.getBoundingClientRect().left)},up=left(side?.querySelector('a[href$="/upcoming"]')),plan=left(nav?.shadowRoot?.querySelector('button')),cur=side?.querySelector('[aria-current=page]')??side?.querySelector('li.current > a'),c=cur&&getComputedStyle(cur);return JSON.stringify({theme:h.className.match(/theme_\w+/g)||[],shadows:[1,2,3].map(i=>v('shadow-raised-'+i)),focusTint:v('actionable-focus-tint'),selectedRowMatches:c?c.backgroundColor===rgb('var(--product-library-selectable-secondary-selected-fill)')&&c.color===rgb('var(--product-library-selectable-secondary-on-selected-tint)'):null,navLabelShift:up!==null&&plan!==null?up-plan:null})})()
   ```

   通过条件：`shadows` 三项都是阴影（含 `px`），不是单个颜色，否则 Plus 的卡片阴影会消失；`selectedRowMatches` 为 `true`，即 Todoist 选中的侧栏行确实使用 Plus 读取的选中底色和文字色（测试夹具只是这样假设）；`navLabelShift` 为 0，否则 Plan／Focus 的文字比 Upcoming 靠左这么多像素，需调整导航槽。另看 Todoist 自己的焦点框是否为 `focusTint`，记录即可，Plus 的焦点框有意不用它（见[设计](design.md#界面)）。

2. 任务弹窗，先打开一个有小步骤的任务，再从它打开一个小步骤，各运行一次：

   ```
   (()=>{const m=document.querySelector('[data-testid=task-details-modal]');if(!m)return'no task modal';const own=m.querySelector('[data-testid=task-main-content-container]')?.closest('[data-item-id]'),inside=!!own&&m.contains(own),row=inside?own:m.querySelector('[data-testid=task-selection-list-container] [data-item-id]')??m.querySelector('[data-item-id]'),id=row?.getAttribute('data-item-id'),p=location.pathname.replace(/\/$/,'');return JSON.stringify({taskLink:/\/task\/[^/]+$/.test(p),from:inside?'own row':row?'list':'none',matchesLink:!!id&&(p.endsWith('/'+id)||p.endsWith('-'+id))})})()
   ```

   通过条件：两次都是 `taskLink: true` 和 `matchesLink: true`。`matchesLink` 为 `false` 时 Plus 不挂载“步骤与时间”，设置页显示任务 ID 不一致，应先修改 `src/anchors.ts`；`taskLink` 为 `false` 时 Plus 无法用地址交叉核对，须用下面第 4 步目视确认后才能发布。

### 更新后六步核对

Todoist 或 Plus 更新后，在真实 Chrome 中按顺序检查（只看界面，不记录任务内容）：

1. 侧栏出现 Plan／Focus，设置页的“Todoist 页面检测”为全部正常。
2. 打开 Plan，原生列表隐藏；Today 返回原生页面，筛选器和标签按原样显示。
3. Other views 能展开和收起其他收藏，刷新后保持上次的开合。
4. 打开一个有小步骤的任务，“步骤与时间”列出的是它自己的小步骤。
5. 在步骤输入框中输入 q 或 a，不打开 Todoist 的快速添加。
6. 切换一次 Todoist 的浅色主题（如 Kale 与 Default），Plus 立即跟随；Plus 没有深色模式。

## 截止日期第一版（2026-10-16，本地）

同日的 owner 定稿取代了本节的“截止日期 · N”和“等待中”两个列表，见下一节；`SetTaskPlan.active`、替代的三个筛选器、任务详情的状态句和按钮、Other views 的开合以及 `--plus-danger` 保留。

owner 批准的设计第一版（§1 启动窗口、§3 收藏筛选器、§5 的 `SetTaskPlan.active`）在本地分支 `claude/plus-deadlines` 完成，未推送、无分支 CI 或发布。全部使用合成数据，未打开真实 Todoist、FlowDay 或 Cloudflare 账户。

- 单元／交互：`deadlines.ts` 的规则表、排序和中英文状态；Focus 一行的计数（任务或未完成步骤已排进队列就不数，已完成的队列项不算排进）；客户端一致性（按 API 字段，“截止日期”和“等待中”恰好列出约定的任务）；“截止日期”的位置、默认展开、手动开合、标为进行中的单次写入、读屏结果和焦点移动；没有 `active` 标签时不出现该操作；“等待中”的截止日期文字；Focus 跳转；任务详情状态句、按钮和 `1 day`；事项卡的可访问名称；Other views 开合的保存、读取和断开清除。
- 实际 MV3 构建包：五种状态的行在平时透明度为 0 的操作、悬停后出现、从标题 Tab 到操作；标为进行中只发一次 SetTaskPlan `{active: true}` 且不再读取任务列表；Focus 一行跳到 Review 并聚焦 summary；窄窗口折行无溢出；Other views 刷新后保持；九个主题中 `--plus-danger` 文字对背景至少 4.5:1。

## 该开始与等待中两列（2026-10-16，本地）

owner 当天的定稿：没有新标签页；Review 从左到右为“该开始”“等待中”和四个规划列，前两列没有卡片时隐藏，每个任务只在一列（自己的规划标签 → `@waiting`／`@blocked` → 启动窗口已开或已过截止 → 日期规则）；从“该开始”拖入规划列一次写入规划标签和 `active`，卡片悬停时的“开始”只加 `active`，从“等待中”拖入只写规划范围，两列都不接受投放；没设提前量只在周回顾占一行；看板和日历下方不再叠放任何列表；Plus 不再有深色模式。仍在本地分支 `claude/plus-deadlines`，未推送、无分支 CI 或发布；全部使用合成数据，未打开真实 Todoist、FlowDay 或 Cloudflare 账户。

- 单元／交互（163 个）：`review-lanes.ts` 的列规则、两列的排序和中英文状态；客户端一致性（按 API 字段的每种组合，任务至多在一列，在等或该开始的任务恰好在一列并写明状态）；列顺序与隐藏；从“该开始”拖入时的预期标签、等待卡片和失败撤回，没有 `active` 标签时只写规划范围；从“等待中”拖入保留在等标签；“开始”的单次写入、读屏结果和焦点移动，拖动未确认时停用；周回顾提前量一行用编辑器的下拉框写入；Focus 一行和周回顾的跳转聚焦对应列；任务详情的状态句和按钮；看板和日历下方没有叠放的列表。
- 实际 MV3 构建包（26 个 Chromium 用例，Kale 浅色）：六列一行、同宽、同样的卡片样式，只有“已过 N 天”用 danger；“开始”平时透明度为 0，悬停出现而标题和状态不动，从卡片 Tab 到达，只发一次 SetTaskPlan `{active: true}`、不再读取任务列表，焦点移到下一个“开始”；该开始的卡拖入本周承诺立即显示为等待确认的卡并只发一次 `{stage: committed, active: true}`；等待中的卡拖入本周只发 `{stage: weekly}`，卡片仍写明在等；落在两列上不写入；Focus 一行和周回顾的跳转聚焦对应列；提前量一行发一次 SetTaskLead 后消失；640px 下各列堆叠且无溢出；八个浅色主题的对比度和无 token 时的浅色后备。
- Todofy：替代筛选器的一致性测试改为：每个查询选出的任务都在看板上（必须开始或在等），或已是进行中；没设提前量的查询改为周回顾那一行。查询集合和后端行为不变。

截图（Kale 浅色，实际构建包和合成页面）供 owner 审阅：两列在最左的看板、该开始的卡拖向本周承诺和落下后等待确认、悬停显示“开始”、周回顾的提前量一行；界面文档的图片同日重截。真实 Todoist 页面、已安装的扩展、分支 CI 和发布均未验证。
