# Todoist Plus 验收

## 本地检查

2026-10-13 的本地工作树已通过：TypeScript、ESLint、20 个单元／交互／API 检查、生产构建、ZIP 构建，以及 3 个实际 MV3 Chromium 浏览器检查。发布 SHA 和真实账户验收由根 HANDOFF 单独记录。

- React 交互、计划派生和根 proto HTTP 客户端使用合成数据验证：父子任务计数、提醒保留、一次调整承诺、停止与真正完成的区别、完成重试身份、字段掩码、未知估时、跨午夜计时。
- `test:browser` 加载 `.output/chrome-mv3` 实际构建包，在新建的临时 Chromium profile 运行；页面为合成 Todoist DOM，服务端通过 background 内的独立假响应提供。不访问真实任务或个人浏览器 profile。
- 浏览器检查覆盖侧栏挂载、原生页面恢复、旧筛选器隐藏、background API 调用、失败完成保持可见并以相同 ID 重试、计时冲突刷新、FlowDay 本地与杂项条目、任务详情父子 ID、暗色主题和语言，以及映射失效／连接失效后恢复旧控件。

构建包测试曾实际捕获 WXT 默认 host reset 导致隐藏和主题无效的问题；挂载点已明确开启样式继承，并保留相应回归。

## 上线验收

发布成功、真实 Todoist 的视觉融合、PWA、键盘输入、真实 Todoist 任务写入与下一次自然周重置须分别记录。上述合成测试不能代替这些结果；当前生产验收由根 HANDOFF 记录。
