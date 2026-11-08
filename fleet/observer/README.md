Observer 在 `platform/src/personal_cloud/observer/`，随平台镜像发布。
`platform-observer` k3s CronJob 每五分钟使用只读 projected ServiceAccount 与独立状态 PVC 发送签名报告。
宿主只读挂载系统 bus socket、meminfo、PID 1 的 `net/dev`（宿主网络命名空间）以及 `/usr/lib/os-release`、`/var/lib/rancher/k3s`
（仅作 statvfs 目标，不列出、不读取）；采集四个固定 systemd unit 元数据与节点数值，权限边界见 `platform/systemd/README.md`。
节点数值（`platform/src/personal_cloud/observer/metrics.py`）只含数字：累计 CPU 时间、负载、内存与 swap、文件系统、
物理网卡合计字节数（不发送网卡名）、boot ID 与 uptime，以及按声明别名汇总的 CPU 与内存
（metrics.k8s.io，最多 16 个）。读不到的部分直接省略，不猜测为零。

Deployment 与 Pod 模板上的 `fleet.ziyixi.science/workload` 标签由部署声明生成。观察器跨命名空间读取带标签的
Deployment、当前 Pod 和 Pod metrics，新增工作负载不需要再改 Fleet 的列表。独立就绪清单保留无 Pod 的 Deployment；
运行中的 CronJob Pod 只参与资源曲线。已结束、删除中的 Pod 不参与当前值。清单读取失败、分页不完整或别名冲突保持未知，
不与发布版本核验混用。就绪探针未声明时明确显示；Kubernetes Ready 不代表外部入口或业务成功。

只读发现权限的唯一来源在 `platform/k3s/observer-discovery`。正常 main 发布先通过受控 Actions 核对并应用它，
VPS 发布等待该步骤与 Fleet 消费端成功后再更新观察器。身份没有 Secret、日志、exec 或修改资源的权限。
内存可用量是 MemAvailable 加上 ZFS ARC 高于 `c_min` 的部分（与 htop、btop 同一规则：内核在内存压力下回收它，
MemAvailable 却不计入），不超过总量；ARC 统计是内核全局、所有用户可读的 `/proc/spl/kstat/zfs/arcstats`，无需挂载。
非 ZFS 主机或该文件读不到、格式不对时只用 MemAvailable。心跳的内存百分比用同一读数，`memory_high` 与资源曲线一致。
k3s/节点离线时报告停止，Fleet 呈现 stale/missing；没有宿主 binary、用户、timer 或长效 Kubernetes token。
