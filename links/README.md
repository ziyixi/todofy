# Links

私人短链接和启动页。`/<key>` 跳转到保存的 HTTPS 目标，`/_/` 是 Access 保护的管理界面。公开短链接匿名可用；
私有、未知、删除或过期的 key 对非 owner 给出相同响应，避免枚举。

```sh
bazel test //links:check
bazel build //links
```

## 使用

管理页支持搜索、新建、编辑、软删除/恢复、修订和 JSON Lines 导入导出。链接可 exact、追加路径或用 `{path}`
模板；不透传查询串，不允许改变目标 origin。预览用 `/<key>+`。

把配置中的主机添加为浏览器 Site Search，例如快捷字 `s`、URL `https://<host>/%s`，即可从地址栏使用。手机可
打开管理页并添加到主屏。私有链接依赖同一浏览器的 owner Access 登录。

跳转固定为 302/no-store，一次索引读取、零写入，不记录 key、访问路径、目标或点击统计。只有 `/_` 和 `/_/*`
被 Access 覆盖；不能把整个主机放进 Access。规则和边界见[设计](docs/design.md)。

## 维护

一个 Worker、D1 和独立 LinksBackup Alarm；没有 KV 或 cron。日备份写私有 R2、保留完整恢复能力，跳转不触发
备份。见[备份与恢复](docs/backup.md)。

主配置是 `wrangler.toml`，owner 身份复用 Home 的声明。正常发布只走同一 green SHA 的 main Actions：检查完整
产物、hostname guard、D1 migrations、无重新打包上传、实际版本/Access/匿名跳转验证和最终对账。不要重做旧 L1/L2
上线清单或绕过 wrapper。

交互式开发用原 local-only `dev` 入口；build/test/type/lint 委托 Bazel。接口在根 `links.ui.v1`，鉴权复用
edge-auth。详见[协作规则](AGENTS.md)、[依赖](../docs/dependencies.md)与[CI/CD](../docs/ci-cd.md)。
