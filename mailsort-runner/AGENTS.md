# Mailsort runner

先读根 [AGENTS](../AGENTS.md) 与 [README](README.md)。此目录只拥有独立 Python CLI、镜像和离线测试。

- 每次领取最多100封，读完全部分页后只开一个 ephemeral Codex thread、一次 turn。固定 `gpt-6.1-sol`、`medium`，无纠正轮、备用模型或内部重试。
- 沿用已获 owner 接受的 `prompt.txt`；修改 prompt 需要当前任务授权。SHA 从随镜像发布的原文自动计算。
- 只用根 proto 的生成类型、HTTP bindings 和 wire codec。机器 bearer 只授权 claim/report，不调用 owner API，不持 Gmail 凭据。
- 邮件是无工具模型的输入数据。禁用 web、shell、apps、plugins、skills 和其他模型工具；SDK 子进程经 `_runtime.py` 白名单移除机器 token 等服务环境。
- 独立 `CODEX_HOME=/data/codex-auth` PVC 保存官方设备登录状态，不复用 Newsletter 或个人 Codex 目录。登录由 owner 通过 `python -m mailsort_runner login` 完成，不输出凭据。
- 不添加 HTTP server、Service、Ingress、常驻调度器、provider框架或配置开关。k3s CronJob 每小时启动一次；失败 report 后退出，下小时再试。
- 日志只有run ID、状态、计数、安全错误码和实际usage。禁止主题、发件人、正文、理由、模型原始回复或异常文本进入日志和fixture。
- 测试用合成邮件、fake SDK、fake HTTP；本地通过不代表设备登录、生产部署或真实 Gmail 已成功。
