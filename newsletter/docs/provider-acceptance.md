# 供应商 Schema 联调

离线 CI 检查合同、错误边界、用量、渲染、安装包和 Linux 镜像。共享客户端 smoke 只用合成 HTTP transport；供应商 Schema 接受能力、额度、来源访问与成稿质量需要分别取得真实证据。

需要检查已部署模型的输出结构时，在既有隔离运行环境中显式执行：

```sh
python -m newsletter.schema_smoke --allow-model-calls
```

这会通过 Router 顺序调用 brief、deep、repair、review 四个生产 Schema，消费少量模型额度；必须取得这项调用的授权。请求只要求空诊断结构，不生成刊期，不访问业务数据库、Notion、Todofy 或邮件。工具首个失败即停止，关闭短会话，只记录安全错误码和供应商上报用量；诊断用量不计入刊期账本。

启动和逐次调用仍会在请求前拒绝已知不支持的 Schema 关键字。Schema 被接受后，仍须独立核对来源观察、冻结预览、覆盖记录和真实图表；收件验收另需发信授权。详细范围见[真实联调](live-acceptance.md)。
