# Todoist Plus

把周计划和 FlowDay 放进 Todoist 的 Chrome 扩展。支持普通网页与同一 Chrome profile 安装的 PWA；Todoist 原生桌面、手机应用不能安装它。

- **Plan**：按父任务展开本周承诺和候选，将小步骤拖到某天或调整顺序；支持上一周、下一周和回本周。窄窗口显示三日或单日，通过日期按钮切换。
- **步骤与时间**：批量添加小步骤、修改已有任务估时，编辑真实 Deadline 和提前开始窗口。
- **Focus**：执行今天已安排的步骤，查看父任务、估时并计时或完成；“调整计划”返回 Plan。暂停或结束计时不会完成任务。

拖到某天只改 FlowDay 队列，保留 Todoist 的计划日期和 Deadline。父任务数量按承诺计算，子任务可以单独安排；正在计时的步骤先结束计时再移动。
浏览其他周不改变当前承诺标签。父任务与其步骤使用同一色标，完整名称保留在详情中。

现有标签和筛选器保留。替代的规划项在本地隐藏，其他筛选器和标签收藏收进“Other views”；项目收藏保持可见。停用扩展并刷新即恢复原界面。FlowDay 的本地任务和杂项时间仍保留。

## 安装和连接

1. 下载 GitHub Release 的 `todoist-plus-*.zip`，解压到固定的专用目录，例如 macOS 的 `~/Documents/chrome_extensions/todoist-plus`。不要混用 Recall 的目录。
2. 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，选中包含 `manifest.json` 的目录。
3. 打开 Todofy owner 页面 `/plus`，核对标签映射并确认；生成一个命名的扩展连接。
4. 打开 Todoist Plus 扩展设置，粘贴该页面给出的 API origin 和一次性口令。只授权这个 API origin，然后连接。
5. 刷新 Todoist，侧边栏出现 **Plan / Focus**。

更新时把新版本解压覆盖同一个目录，在 `chrome://extensions` 点击该扩展的重新加载，再刷新已经打开的 Todoist 页面；连接保存在扩展本地存储中。旧页面提示扩展已更新时，其“刷新”会重新加载整页。换目录或卸载可能改变扩展身份，需要重新连接。口令可在 Todofy 的 `/plus` 单独撤销。从旧目录切换时先停用旧扩展，避免两个版本同时运行。

扩展只用一个连接口令。FlowDay 仍需其原有的 Todoist 只读连接；如果缓存旧或无法加入新步骤，在 FlowDay 设置检查同步状态。Todoist API key 不进入扩展。

## 本地开发

需要 Node.js 26 和根 proto 工具链。进入此目录运行：

```sh
npm ci
npm run prototype     # 纯合成内容，http://127.0.0.1:18795/
npm run typecheck
npm run lint
npm test
npm run build
npx --no-install playwright install chromium
npm run test:browser  # 实际 MV3 包，临时 Chromium profile，合成 Todoist 页面
npm run zip
```

构建目录为 `.output/chrome-mv3`。浏览器测试不会访问个人 Chrome profile 或真实 Todoist 数据。发布与后端复用 monorepo 的 CI，详情见[设计](docs/design.md)和[验收记录](docs/verification.md)。
