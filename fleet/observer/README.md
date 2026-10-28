Observer 在 `platform/src/personal_cloud/observer/`，随平台镜像发布。
`platform-observer` k3s CronJob 每五分钟使用只读 projected ServiceAccount 与独立状态 PVC 发送签名报告。
宿主只读挂载系统 bus socket、meminfo、PID 1 的 `net/dev`（宿主网络命名空间）以及 `/usr/lib/os-release`、`/var/lib/rancher/k3s`
（仅作 statvfs 目标，不列出、不读取）；采集四个固定 systemd unit 元数据与节点数值，权限边界见 `platform/systemd/README.md`。
节点数值（`platform/src/personal_cloud/observer/metrics.py`）只含数字：累计 CPU 时间、负载、内存与 swap、文件系统、
物理网卡合计字节数（不发送网卡名）、boot ID 与 uptime，以及本 namespace Pod 按 `app` 标签或 CronJob 名汇总的 CPU 与内存
（metrics.k8s.io，最多 16 个）。读不到的部分直接省略，不猜测为零。
内存可用量是 MemAvailable 加上 ZFS ARC 高于 `c_min` 的部分（与 htop、btop 同一规则：内核在内存压力下回收它，
MemAvailable 却不计入），不超过总量；ARC 统计是内核全局、所有用户可读的 `/proc/spl/kstat/zfs/arcstats`，无需挂载。
非 ZFS 主机或该文件读不到、格式不对时只用 MemAvailable。心跳的内存百分比用同一读数，`memory_high` 与资源曲线一致。
k3s/节点离线时报告停止，Fleet 呈现 stale/missing；没有宿主 binary、用户、timer 或长效 Kubernetes token。
