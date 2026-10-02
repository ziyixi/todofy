# Newsletter 入仓来源

源仓库：[ziyixi/newsletter](https://github.com/ziyixi/newsletter)。
本次最终基线为 [c3d622d4771b1ca63ee4e3f785b79032cffc30e1](https://github.com/ziyixi/newsletter/commit/c3d622d4771b1ca63ee4e3f785b79032cffc30e1)。

先从本地干净提交 28882c27dcdbbb6119805ed3f8aa4f1fb8a9ab91 的 Git archive 导入
224 个 tracked 文件，排除源 `.github/` 三个工作流。随后用公开 compare 核对 main，
确认只领先一条提交，合入其 `src/newsletter/todofy.py` 与 `tests/test_todofy.py`。
不重写 Git 历史；源提交与历史继续可从上面的固定链接查阅。

没有导入 `.git`、私有 env、Codex auth、真实数据库/邮件、生成结果或 untracked
构建物。源工作流移到 monorepo 根 `.github/workflows/`；测试读取实际根入口。
入仓后的新增功能为持久发布排空，详见 [发布排空合同](deployment-drain.md)。

当前旧 VPS 基线使用 `ghcr.io/ziyixi/newsletter:service-c3d622d4771b1ca63ee4e3f785b79032cffc30e1`。
monorepo 后续发布的独立镜像改为 `ghcr.io/ziyixi/todofy-newsletter`，不从 `GITHUB_REPOSITORY` 推导镜像名。
`ziyixi-protos==0.1.0.dev7` 的外部 wheel、hash 与现有业务合同继续保留，本轮不迁移
至 monorepo 根 proto。镜像 OCI source 指向 Todofy monorepo。

根 CI 从同一提交做离线检查、构建并验证镜像，归档后发布同一镜像身份。配置发布
只接受实际 `Newsletter image publish` job 成功的 main push；整体绿色或跳过镜像
发布不证明该提交有已发布引擎。配置 source 为 `newsletter/content-config/`，
bundle 的 engine SHA 与 revision 是 monorepo commit，发布分支仍为 `published`。

旧 VPS 的 image digest、config-sync 源仓库、定时器、auth/data 与业务设置不随入仓
自动改变。新 monorepo 配置不会被旧的 `ziyixi/newsletter` 同步器自动采用。后续部署
须显式迁移唯一同步器来源和固定 digest，不能同时运行两套每日触发器。
