Observer 在 `platform/src/personal_cloud/observer/`，随平台镜像发布。
`platform-observer` k3s CronJob 每五分钟使用只读 projected ServiceAccount 与独立状态 PVC 发送签名报告。
宿主只挂载系统 bus socket 与 meminfo，只读采集四个固定 systemd unit 元数据；权限边界见 `platform/systemd/README.md`。
k3s/节点离线时报告停止，Fleet 呈现 stale/missing；没有宿主 binary、用户、timer 或长效 Kubernetes token。
