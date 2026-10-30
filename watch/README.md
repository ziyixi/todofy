# Watch

私人网页、Feed 和 JSON 监视。一个 SQLite DO 调度检查，保存有界文字/链接/元数据及可选截图。Watch 保持确定性
规则和基线，Dots 读取证据后判断是否有意义；服务器不调用模型替你判断。

```sh
bazel test //watch:check
bazel build //watch
```

## 使用

添加网址后先预览，选择保留/排除块、触发规则和间隔，再保存。分享链接 `/new#u=` 只填表，不立即抓取。首次检查
建立基线，不伪报变化；后续在变化页确认或查看过滤原因，忽略行可以撤销。

HTTP 是默认抓取方式；浏览器模式保存渲染内容与截图，使用既有最小检查间隔和每日浏览器秒数账本。查看变化前后
页面或截图只读已保存证据，不重新访问网站。未记录、过期、截断、失败分别显示，不代表“无变化”。

健康页说明 robots、退避、人机验证、配额或失败原因。所有跳转沿用同一 URL/抓取政策，不绕过验证。详见
[规则](AGENTS.md)和[设计](docs/design.md)。

## Dots 与通知

私有 WatchApi 按 binding 的 read/read-write 权限开放。Dot 指派的 Watch 可选择 `notify_policy=NONE`：仍记录
变化/健康事件，但不创建 Tasks 通知。Intent 和判断关联在 Work；不据此自动改变抓取基线或学习忽略规则。

普通通知只含 owner 命名、触发类型/次数和 Watch 链接，不带页面正文、截图或监视 URL。摘要/紧急通知沿用原有
TaskInbox 日额度和冻结 request ID。确认回调、形成任务与 Dot 完成工作是不同事实。

## 维护

Worker 只做鉴权和对象调用；DO/私有 R2 保存状态与证据，定时工作只用 Alarm。日备份包括所有表及引用的证据，
恢复只进入空存储，不重放旧通知。见[备份/恢复](docs/backup.md)。

构建、类型、单元、真实 workerd/CPU 和 smoke 由 Bazel 检查，测试只访问合成页面。交互开发保持 local-only
绑定和原假站点；生产只走同一 green SHA 的 main Actions，在 Tasks 就绪后上传已检查的完整产物并核对对账。

停用/删除是单独的业务和数据决定：先暂停抓取/通知，保留恢复需要的数据与清单，再按明确计划处理资源。普通
代码回退使用 Git/Actions，不回退单个 Worker 或直接删除对象。
