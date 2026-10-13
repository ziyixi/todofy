# Todoist Plus

把周计划和 FlowDay 放进 Todoist 的 Chrome 扩展。支持普通网页与同一 Chrome profile 安装的 PWA；Todoist 原生桌面、手机应用不能安装它。

- **Plan**：工作／生活的本周承诺、候选、重点和启动窗口；一次选择调整对应标签。
- **步骤与时间**：批量添加小步骤、估时，编辑真实 Deadline 和提前开始窗口。
- **Focus**：沿用 FlowDay 的今天队列与计时器。勾选完成真实 Todoist 子任务；暂停、结束计时不会完成任务。

现有标签和筛选器保留。连接成功后只隐藏已确认被界面替代的项；停用扩展并刷新，恢复 Todoist 原界面。FlowDay 的本地任务和杂项时间保留在队列中，点击链接回 FlowDay 处理。

## 安装和连接

1. 下载 GitHub Release 的 `todoist-plus-*.zip`，解压到固定的 **Todoist Plus 专用目录**。不要放进 Recall 的扩展目录。
2. 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，选中包含 `manifest.json` 的目录。
3. 打开 Todofy owner 页面 `/plus`，核对标签映射并确认；生成一个命名的扩展连接。
4. 打开 Todoist Plus 扩展设置，粘贴该页面给出的 API origin 和一次性口令。只授权这个 API origin，然后连接。
5. 刷新 Todoist，侧边栏出现 **Plan / Focus**。

更新时把新版本解压覆盖同一个目录，在 `chrome://extensions` 点击该扩展的重新加载；连接保存在扩展本地存储中。换目录或卸载可能改变扩展身份，需要重新连接。口令可在 Todofy 的 `/plus` 单独撤销。

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
