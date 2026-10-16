# Todoist Plus

把周计划和 FlowDay 放进 Todoist 的 Chrome 扩展。支持普通网页与同一 Chrome profile 安装的 PWA；Todoist 原生桌面、手机应用不能安装它。

- **Plan / Review**：紧凑看板从左到右显示该开始、等待中（都只在有卡片时出现）和本季度、本月、本周待选、本周承诺，拖动事项调整规划范围。启动窗口已开或已过截止的任务出现在“该开始”，拖入某列或点卡片上的“开始”即标为进行中。每个规划列对应一个现有 Todoist 标签，可在“计划标签”中选择。
- **Plan / Week**：先看本周承诺总览，再展开某个事项的小步骤，拖到具体日期或调整顺序；支持上一周、下一周和回本周。窄窗口显示三日或单日。
- **本周目标**：工作和生活的整体目标单独显示，用现有任务的 Bets 标记；更换目标不会调整任务的承诺状态或日期。
- **步骤与时间**：批量添加小步骤、修改已有任务估时，编辑真实 Deadline 和提前开始窗口。
- **Focus**：执行今天已安排的步骤，查看父任务、估时并计时或完成；“调整计划”返回 Plan。暂停或结束计时不会完成任务。
- **等待中**：Review 的第二列显示 `@waiting`／`@blocked` 任务和在等其他任务的任务，最久未变动的在前，有截止日期时一并显示；点击打开任务详情。不移除标签，也不联系任何人。
- **依赖**：在任务详情的“依赖”段输入即搜索，选择这个任务要等的任务；会互相等待的任务灰色不可选。依赖只存在 Todofy，不改 Todoist 的标题、描述或标签，手机和没装扩展的 Todoist 看不到。在等的卡片写“等「B」”；B 完成后显示为可以开始（循环任务以建立之后的下一次完成为准），不改日期或标签；B 被删除时在 Review 提示一次。
- **周回顾**：五行清单（邮件待理清、等待中、承诺未安排、将来／也许、下周承诺）带数量和跳转，有截止日期没设提前量时多一行，可直接选择提前量；按 ISO 周在本浏览器勾选；Todofy 的周日回顾任务链接到它，“完成回顾”只在点击时完成该任务。

拖到某天只改 FlowDay 队列，保留 Todoist 的计划日期和 Deadline。父任务数量按承诺计算，子任务可以单独安排；正在计时的步骤先结束计时再移动。
浏览其他周不改变当前承诺或本周目标。周一会把未完成的承诺放回待选；周日在 Plus 中选的承诺和本周目标留到下周，同一任务的两个标记一起保留。每个承诺与其步骤使用同一色标；卡片先显示标题，下面保留简短的所属事项。

现有标签和筛选器保留。替代的规划项在本地隐藏，其他筛选器和标签收藏收进“Other views”；项目收藏保持可见。颜色跟随 Todoist 当前的浅色主题；Plus 没有深色模式。停用或重新加载扩展后，回到 Todoist 标签页即恢复原界面，无需刷新；Plus 显示出错时只留一行“返回 Todoist / 重新加载”。FlowDay 的本地任务和杂项时间仍保留。

## 安装和连接

1. 下载 GitHub Release 的 `todoist-plus-*.zip`，解压到固定的专用目录，例如 macOS 的 `~/Documents/chrome_extensions/todoist-plus`。不要混用 Recall 的目录。
2. 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，选中包含 `manifest.json` 的目录。
3. 打开 Todofy owner 页面 `/plus`，核对标签映射并确认；生成一个命名的扩展连接。
4. 打开 Todoist Plus 扩展设置，粘贴该页面给出的 API origin 和一次性口令。只授权这个 API origin，然后连接。
5. 刷新 Todoist，侧边栏出现 **Plan / Focus**。

更新时把新版本解压覆盖同一个目录，在 `chrome://extensions` 点击该扩展的重新加载，再刷新已经打开的 Todoist 页面才加载新版本；连接保存在扩展本地存储中。扩展设置页底部的“Todoist 页面检测”一行显示最近一次页面检查：全部正常，或哪项增强已关闭及原因；它只含固定的键，不含任务内容，也不离开浏览器。旧页面提示扩展已更新时，其“刷新”会重新加载整页。换目录或卸载可能改变扩展身份，需要重新连接。口令可在 Todofy 的 `/plus` 单独撤销。从旧目录切换时先停用旧扩展，避免两个版本同时运行。

扩展只用一个连接口令。FlowDay 仍需其原有的 Todoist 只读连接；如果缓存旧或无法加入新步骤，在 FlowDay 设置检查同步状态。Todoist API key 不进入扩展。

## 本地开发

需要 Node.js 26 和根 proto 工具链。进入此目录运行：

```sh
npm ci
npm run prototype     # 原型 /；正式组件合成预览 /production.html
npm run typecheck
npm run lint
npm test
npm run build
npx --no-install playwright install chromium
npm run test:browser  # 实际 MV3 包，临时 Chromium profile，合成 Todoist 页面
npm run zip
```

构建目录为 `.output/chrome-mv3`。浏览器测试不会访问个人 Chrome profile 或真实 Todoist 数据。发布与后端复用 monorepo 的 CI，详情见[架构](docs/design.md)、[界面与接口说明](docs/planning-interface.md)和[验收记录](docs/verification.md)。
