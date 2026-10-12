# iPhone 与多设备

电脑和手机连接同一个 Recall。每次独立安装都有自己的设备 ID、访问记录和待上传队列；云端统一搜索，
Dropbox 统一归档。手机不需要连接 Dropbox，也不用复制电脑的扩展目录或本地数据库。

## 手机安装

1. 在 [GitHub Releases](https://github.com/ziyixi/todofy/releases) 下载当前版本的
   `recall-orion-v<version>.zip`，保存到“文件 → 我的 iPhone”。不要选 Chrome 的 `recall-extension` 包。
2. Orion → `…` → 设置，允许 Chrome 扩展；再进入 `…` → 扩展 → `+` → 从文件安装，选择该 ZIP。
3. 在手机打开 Recall → 设置 → 插件口令，填写 `iPhone`，点“添加设备口令”，复制。
   打开 Orion 的 Recall 扩展设置，粘贴口令，设备名称填 `iPhone`，保存。服务器地址已经填好。
   保存只确认本机设置已写入，上传结果在下方单独显示。手机包固定使用手机模式，不依赖浏览器标识。
   超过十二秒未收到回执会显示“保存尚未确认”和等待步骤，并保留输入的口令；不要重新生成口令。

口令只显示一次，不要发到聊天。电脑原有口令继续可用。手机丢失或不再使用时，停用这条独立口令即可，
不影响其他口令或已上传的记录。独立口令是上传凭据，名称便于辨认；同一口令若被复制到多个设备，
停用时这些设备都会停止上传。

已安装的设备名称会保留；如果旧版曾默认显示 `Chrome`，改成 `iPhone` 再保存即可。

文件安装版的手机更新仍需下载新 Orion 包。先在扩展管理里使用当前扩展的更新入口（若该版本提供）；
不要先卸载，卸载会删除尚未上传的本地记录。Orion 是否保留安装身份和设置需要首次真机验收，
不能套用 Mac 固定目录自动更新的说明。

## 最后一次手机验证

完成安装和设置后，只需这一轮：

1. 在 Orion 打开 `https://example.org/?recall-mobile-check=1`，保持前台约 20 秒。
2. 回到扩展设置，点“立即上传”。应显示最近连接成功，以及最近采样的正文结果和 `WebP` 或 `JPEG`。
3. 切到其他 App，再返回 Orion。再浏览该公开页面约一分钟，立即上传，然后在 Recall 时间线选择 `iPhone`，
   点开这页，确认正文和截图可见。画面没有明显变化时不应每分钟增加截图；离开浏览器的时间不应算作浏览时间。

若卡住，只报告安装是否成功，以及扩展设置里的采集环境、最近采样和最近错误。无需发送口令、私人网页或完整截图。

## 记录与归档

- 前台累计十秒后首次采集，之后复用分钟检查。相同访问中，正文与画面没有明显变化就省略快照。
- Orion iOS 使用顶层页面的文档身份和可见状态。切 App、锁屏和浏览器暂停期间不承诺执行定时任务；
  返回前台后继续既有队列。截图保存后尽快上传，失败继续使用原来的退避，不新建后台任务服务。
- 截图优先原生 WebP；浏览器不支持其编码时使用原生 JPEG。同样限制最长边 1920 像素、质量 0.75、384 KiB。
  截图失败时正文仍可保存，扩展显示具体结果。隐私名单、密码页和无痕排除继续适用。
- 两台设备访问同一网址会汇总到同一页面，但访问和快照分别保留设备来源；去重不会因另一台设备采集过而跳过。
  时间线可选全部设备或某一台，重叠时间仍按实际时间并集统计。
- 所有设备共用七天热文件窗口及同一 Dropbox 归档。只有正文和截图已确认归档后才从 R2 移出；
  搜索索引保留，旧快照直接从 Dropbox 读取。增加设备不需要增加备份服务。
- 手机显示最近连接、待上传和实际错误。连接成功可能只是空心跳；待上传为零表示队列为空，不能证明已经采集。实际访问记录在网站时间线按设备查看。一天没有打开浏览器不算上传故障。

## 本地验证

Agent 先运行现有扩展测试，再用本机真实 WebKit 打开实际构建的设置、后台和公开测试页面。
四项保存检查覆盖正常保存、采集查询卡住、设置写入卡住、保存后的状态刷新卡住。
两项采集检查分别验证加载完成事件和自动分钟 Alarm 能启动采集：执行产物里的真实 `probe.js` 与
`capture.js`，通过原生 IndexedDB 保存正文，原生画布压缩 JPEG，再解开实际 gzip 请求核对假消费者收到的内容。
同一页面的下一次采样不能多存快照；页面离开必须结束访问，消费者最终只收到一份正文和一条访问。
这些检查不手动发出 Alarm，不用手写 probe 返回值代替注入脚本。
没有新增测试框架或依赖；复用仓库已有的 Playwright。以下命令在仓库根目录执行（本机须已有 WebKit）：

```sh
npm --prefix recall/extension run build
node --input-type=module <<'JS'
import { webkit, expect } from './website/node_modules/@playwright/test/index.mjs';
import { checkOrionOptions } from './recall/extension/test/options-browser.mjs';
console.log(await checkOrionOptions({ webkit, expect, folder: './recall/extension/dist' }));
JS
```

上述消费者请求由本地测试截获，不访问生产 Recall。扩展 API 桥接与 `chrome.storage.local` 是 fixture；
DOM、脚本执行、IndexedDB、图片压缩与 gzip 是真实 WebKit。它不能证明 Orion 自己的 API 实现或 iOS 前后台挂起行为。
本机未安装 Xcode、iOS Simulator 或 Orion。发布后先下载实际 ZIP 重跑同一检查，再交给 owner 做一次最小真机确认。

设置里的“当前记录”描述当前前台页面；设置页本身不采集。“活动检查”能确认后台是否检查过页面，
“最近采样”始终显示结果或“尚未采样”，不再让空白状态掩盖尚未开始采集。最近错误只显示固定阶段码，
不包含网址、标题、正文或口令。

## 验证边界

[完整分支 CI](https://github.com/ziyixi/todofy/actions/runs/38193778901) 与
[同 SHA 发布](https://github.com/ziyixi/todofy/actions/runs/38194203995) 已通过。
本次准备覆盖双设备上传、口令独立停用、设备筛选、截图去重、JPEG 处理以及真实 DO/R2 配合假 Dropbox 的归档读取。
Orion 非持久后台重建及 pagehide 的停留时间、并发相同请求只返回一次有效口令均有针对性测试。
线上版本 `0c9f27be-d2c9-4556-8a7a-333b8a55d834` 已由部署流程核验，Deployment 为 `7004923541`。
线上只读取了先前的公开测试页面和空的合成设备筛选，没有读取其他浏览正文或改变口令。
本机构建的 Worker gzip 约 125.2 KiB，代码体积预算从 125 调到 130 KiB；运行配额和每日写入预算未变。

这些检查不证明 Orion 真机的扩展安装、页面可见性事件、原生截图和文件更新行为；最后一轮手机验证专门确认这些边界。

参考：[Orion iOS 文件扩展](https://help.kagi.com/orion/browser-extensions/ios-ipados-extensions.html)、
[API 支持表](https://browser.kagi.com/WebExtensions-API-Support.html)、
[Apple 前后台生命周期](https://developer.apple.com/documentation/uikit/preparing-your-ui-to-run-in-the-background)。
