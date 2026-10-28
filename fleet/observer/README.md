Observer 在 `platform/src/personal_cloud/observer/`，随平台镜像发布。
`platform-observer` k3s CronJob 每五分钟使用只读 projected ServiceAccount 与独立状态 PVC 发送签名报告。
宿主只读挂载系统 bus socket、meminfo、PID 1 的 `net/dev`（宿主网络命名空间）以及 `/usr`、`/var/lib/rancher/k3s`
（仅作 statvfs 目标，不列出、不读取）；采集四个固定 systemd unit 元数据与节点数值，权限边界见 `platform/systemd/README.md`。
节点数值（`platform/src/personal_cloud/observer/metrics.py`）只含数字：累计 CPU 时间、负载、内存与 swap、文件系统、
物理网卡合计字节数（不发送网卡名）、boot ID 与 uptime，以及本 namespace Pod 按 `app` 标签或 CronJob 名汇总的 CPU 与内存
（metrics.k8s.io，最多 16 个）。读不到的部分直接省略，不猜测为零。
k3s/节点离线时报告停止，Fleet 呈现 stale/missing；没有宿主 binary、用户、timer 或长效 Kubernetes token。
