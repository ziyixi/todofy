# Mailsort runner

k3s 每小时运行一次 `python -m mailsort_runner`。进程向 Mailsort 领取未分类的未读邮件，收齐最多100封的全部分页后，用一个 Codex SDK turn 返回 P1-P4 和简短中文理由。Mailsort 持久接收结果，由既有 Gmail 账本应用标签与 Inbox 变更。VPS 不持有 Gmail 凭据，也不开 HTTP 端口。

模型固定为 `gpt-6.1-sol`，effort 固定为 `medium`。SDK 和 CLI 都锁定 `0.163.0`。分类 prompt 随镜像发布，报告携带其 SHA-256。模型失败时提交 FAILED 和已取得的用量，然后退出；下一小时重新领取。空批次提交 COMPLETED，且不调用模型。

## 配置与登录

部署注入 `MAILSORT_URL`（Mailsort HTTPS origin）和 `MAILSORT_TOKEN`。也可用 `MAILSORT_TOKEN_FILE` 读取已有 Secret 文件，二者只能设置一个。机器 token 只发给 Mailsort 的 claim/report 路由，不进入 Codex 子进程。

`CODEX_HOME` 默认 `/data/codex-auth`，应挂载独立、uid/gid 10001 可写的 PVC。此目录只用于本应用的官方 ChatGPT 登录与运行缓存，不放自定义 `config.toml`、AGENTS、插件或MCP配置，不复用 Newsletter PVC。

在挂载该 PVC 的同一镜像临时 Pod 中运行：

```sh
python -m mailsort_runner login
python -m mailsort_runner preflight
```

`login` 调用锁定 CLI 的官方 `login --device-auth`，owner 在浏览器完成登录。`preflight` 只检查 SDK、现有登录和模型目录，不发模型请求，也不读取邮件。设备认证未完成时保持 CronJob 暂停；不得把 token 或 auth.json 粘贴到聊天或仓库。

## 本地检查与镜像

在此目录运行：

```sh
uv sync --locked
uv run --locked ruff check src tests scripts
uv run --locked ruff format --check src tests scripts
uv run --locked pytest -q
```

在仓库根准备最小构建上下文，输出目录必须尚不存在：

```sh
python mailsort-runner/scripts/build.py --sha HEAD_SHA --output /tmp/mailsort-image
docker build --build-arg BUILD_SHA=HEAD_SHA -t mailsort-runner:test /tmp/mailsort-image
python mailsort-runner/scripts/smoke_image.py --image mailsort-runner:test
```

构建复制本应用与根 proto 生成模块，镜像使用 Python 3.12、uv 0.12.10 和非 root 10001。离线 smoke 在 `--network none` 下检查导入、CLI 和锁定身份，不调用模型或生产 API。CI 独立发布 `ghcr.io/ziyixi/todofy-mailsort-runner`，k3s 使用经过验证的 digest。Home 继续读取 Mailsort Ops。

## 状态与隐私

claim 本身不表示分类成功。runner 仅在结果覆盖全批次、无重复ID、优先级有效且理由简短时提交 COMPLETED。usage 使用 SDK 的最新累计 snapshot；重复通知不会重复相加，未取得用量保留为空，失败或缺失标记为 partial。Worker 接收结果与 Gmail 写入完成是两个状态。

日志只记录run ID、状态、数量、安全错误码与usage，不记录邮件或理由。模型运行在临时空目录，使用独立 auth home、禁用的工具和精确环境白名单；邮件仅作为待分析数据输入。真实试验数据、邮件和模型原始回复不随源代码、镜像或测试发布。
