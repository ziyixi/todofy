# 2026-10-02 入仓来源

Newsletter 来源为 [ziyixi/newsletter](https://github.com/ziyixi/newsletter)，导入基线为 [c3d622d4771b1ca63ee4e3f785b79032cffc30e1](https://github.com/ziyixi/newsletter/commit/c3d622d4771b1ca63ee4e3f785b79032cffc30e1)。初始 Git archive 导入 224 个 tracked 文件，排除源工作流，再合入该基线的 Todofy 修复；原历史保留在源仓库。

导入未包含 `.git`、私有环境、登录状态、业务数据库、邮件或未追踪产物。入仓后独立镜像名称为 `ghcr.io/ziyixi/todofy-newsletter`，OCI source 指向 Todofy monorepo。根 CI 验证并提升同一镜像归档；代码和内容配置分别发布。

锁定的外部 `ziyixi-protos==0.1.0.dev7` 及旧业务合同保留；owner 只读接口和 Router 客户端使用根 proto 的各自包。生成代码不提交。

入仓本身没有变更旧 VPS 的镜像、同步器、调度或业务状态。当前构建与操作入口见 [README](../README.md)、[内容配置](content-config.md)和[发布排空](deployment-drain.md)；这里仅保留来源证据。
