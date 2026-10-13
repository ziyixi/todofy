# Todoist Plus 设计

扩展只负责 Todoist 中的界面和显式用户操作。Todoist 保存任务、父子关系、标签与 Deadline；Todofy 是唯一写入者，保存标签映射、周重置与操作去重；FlowDay 保存队列、手动估时和计时记录。

## 界面

WXT + React 的三个 Shadow DOM 挂载点分别提供侧边导航、Plan/Focus 主内容和原生任务详情的“步骤与时间”。字体、颜色和主题继承当前 Todoist。DOM 只用来挂载、取得真实 task ID 和暂时隐藏已替代项；业务数据走根 proto 的类型化 API，不匹配标题、不读取 Todoist 的 React 内部状态。

Plan 使用平铺分组；同一计划阶段内，已选父任务的子任务不重复占配额；月／周候选父任务下的已承诺子任务仍单独显示。Bets 独立判断，仅被另一个 Bet 祖先去重。子任务自己的 Deadline 始终出现在提醒区。工作、生活未确定的项目保留“未分类”入口。候选总额明确按整个账户计数。所有数量上限与大于两小时的步骤都只提示。

已有 Must Start 的 `deadline before` 使用严格上界。提前 N 天标签的实际窗口从 Deadline − (N−1) 天开始；界面显示同一个日期，不改变既有筛选规则。`lead_1m` 沿用 30 天。

## API 与计时

独立的扩展口令只保存在 background 的 trusted local storage；网页 content script 只能提交有限操作，不能读出口令。连接使用独立 hooks API 和 FlowDay service binding，owner 页面仍沿用 Access、Origin、CSRF。

任务完成与创建步骤复用稳定 request ID；失败后不乐观移除任务。计时操作使用服务端 etag 和 command API，同一未知结果重试保留 UUID；冲突后刷新实际状态。跨午夜的运行计时保留原 flow day。队列保存全部 ID，FlowDay 的本地任务与杂项不被误当作 Todoist 任务完成。

手动清空估时显示“未估时”，同步不恢复旧 Todoist duration。新建子任务尚未进入 FlowDay 时，在加入队列或设置估时前进行有界同步。

## 生命周期

扩展仅在已确认连接与映射后隐藏确切的旧筛选器 ID。原生详情启用替代控件时隐藏对应技术标签，office/home 等领域标签继续显示。浏览器导航回原生页面时恢复内容；禁用扩展后刷新即可回到原生界面。公开仓库只保存合成任务、标签和测试凭据。
