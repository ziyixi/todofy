# Todoist Plus 设计

扩展只负责 Todoist 中的界面和显式用户操作。Todoist 保存任务、父子关系、标签与 Deadline；Todofy 是唯一写入者，保存标签映射、周重置与操作去重；FlowDay 保存队列、手动估时和计时记录。

## 界面

WXT + React 的三个 Shadow DOM 挂载点分别提供侧边导航、Plan/Focus 主内容和原生任务详情的“步骤与时间”。字体、颜色和主题继承当前 Todoist。DOM 只用来挂载、取得真实 task ID 和暂时隐藏已替代项；业务数据走根 proto 的类型化 API，不匹配标题、不读取 Todoist 的 React 内部状态。

Plan 左侧按目标展开父任务与小步骤，右侧显示本周七天的有序安排。工作／生活承诺配额仍只计算最高层选择；显示层级不再用配额去重来隐藏子任务。另有承诺的子任务可以独立显示，并标明完整父任务路径。Bets 独立计算；月候选和需要关注的启动窗口可展开。

安排数据复用 FlowDay 的按日队列，不修改 Todoist 的计划日期或 Deadline。同日排序用 UpdateFlow，跨日用现有 RolloverFlow 再定位到目标插入位置；本地任务、杂项及完成记录保留。同日不能调用 RolloverFlow，服务端拒绝相同源日与目标日。

拖动使用项目已有的 @dnd-kit/react 0.3.2，提供预览、空日投放及卡片前插入。日期选择和上下移动提供键盘入口。Focus 的卡片按估时形成可读的时长块，累计预计用时从零开始；没有新增钟点排程或日历存储。父任务路径使用相同的标题清理规则。

正在运行或暂停的步骤不能拖走或移出原日期；切换日期不改变全局计时器。只在今天开始新计时。所有数量上限及长步骤都只提示。

已有 Must Start 的 `deadline before` 使用严格上界。提前 N 天标签的实际窗口从 Deadline − (N−1) 天开始；界面显示同一个日期，不改变既有筛选规则。`lead_1m` 沿用 30 天。

## API 与计时

独立的扩展口令只保存在 background 的 trusted local storage；网页 content script 只能提交有限操作，不能读出口令。连接使用独立 hooks API 和 FlowDay service binding，owner 页面仍沿用 Access、Origin、CSRF。

任务完成与创建步骤复用稳定 request ID；失败后不乐观移除任务。计时操作使用服务端 etag 和 command API，同一未知结果重试保留 UUID；冲突后刷新实际状态。跨午夜的运行计时保留原 flow day。队列保存全部 ID，FlowDay 的本地任务与杂项不被误当作 Todoist 任务完成。

手动清空估时显示“未估时”，同步不恢复旧 Todoist duration。新建子任务尚未进入 FlowDay 时，在加入队列或设置估时前进行有界同步。

## 生命周期

扩展仅在已确认连接与映射后隐藏确切的旧筛选器／规划标签 ID。其余筛选器和标签收藏在原位置收折，项目收藏不改；没有修改账户收藏对象。原生详情启用替代控件时隐藏对应技术标签，office/home 等领域标签继续显示。浏览器导航回原生页面时恢复内容；禁用扩展后刷新即可回到原生界面。公开仓库只保存合成任务、标签和测试凭据。
