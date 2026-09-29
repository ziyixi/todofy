# 全局协作偏好

- 遇到需要用户协助解决的阻碍，例如 GitHub push 权限、登录或人工确认，在确认原因后立即直接询问用户。
- 明确说明卡点、需要用户执行的最小操作（给出具体命令或步骤），以及用户完成后如何继续。
- 不要连续切换工具或渠道尝试解决已确认需要用户介入的权限或登录问题；等待用户协助后再继续受阻步骤。
- 普通代码问题仍自行处理；可继续不受阻且在授权范围内的工作，并清楚区分已完成和待完成事项。
- 不要求用户把 token、密码等密钥发送到聊天中；请用户在本机或服务的正规登录流程中完成认证。

---

# 单仓库

本仓库包含两个独立的 Cloudflare 应用和它们之间唯一共享的合同：

- `mail-hero/`：Mail Hero 收件箱与通用 webhook。开发、验收与安全边界见 [`mail-hero/AGENTS.md`](mail-hero/AGENTS.md)，在该目录内工作时它同样适用。
- `todofy/`：Todofy，`mail.received.v1` 的独立消费者。说明见 [`todofy/README.md`](todofy/README.md)、[`todofy/docs/dev-notes.md`](todofy/docs/dev-notes.md)、[`todofy/docs/ci-cd.md`](todofy/docs/ci-cd.md) 和 [`todofy/docs/cloudflare-setup.md`](todofy/docs/cloudflare-setup.md)。
- `contracts/`：跨应用合同，目前只有 `contracts/mail-received-v1/`（JSON Schema、说明和 golden payload）。

单仓库规则：

- 应用之间从不互相导入代码、包、配置或测试工具；只有 `contracts/` 是共享的。应用读取 `contracts/` 的文件，不读取另一个应用的目录。
- 每个应用独立部署：各自的 `production` 发布 job、Cloudflare 资源、D1、密钥和 concurrency group。一个应用的改动不发布另一个应用。
- Mail Hero 拥有 `mail.received.v1`。改动 payload 构建器时在 `mail-hero/cloudflare` 运行 `npm run contract:update`，把 `contracts/` 的变更放进同一提交；`Contracts` job 必须在合并前证明 Todofy 仍接受每个 fixture。`contracts/mail-received-v1/fixtures/legacy/` 是历史冻结字节，不能改写。
- 每个应用的命令都在它自己的目录下运行（`cd mail-hero`、`cd todofy`）。CI 见根 [`README.md`](README.md)。
