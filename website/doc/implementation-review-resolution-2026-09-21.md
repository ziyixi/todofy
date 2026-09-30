# 实现审查修复记录

日期：2026-09-21。依据：[implementation-review-2026-09-21.md](./implementation-review-2026-09-21.md)。

本文件记录审查项 R1–R10 的实际修改与本地验收结果。原审查文件保留为问题证据，不回写成完成状态。

## 处理结果

| 编号 | 状态   | 修改结果                                                                                                                                                                 | 主要回归证据                                                                                                                                        |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | 已修复 | canonical 按 URL 组成部分比较；RSC 请求带 `_rsc`，最终响应必须是同 URL、200 和 `text/x-component`；PR 对 empty/fixture 的本地生产构建都运行部署合同                      | `tests/support/deployment-contract.ts`、`tests/e2e/deployment.spec.ts`、`tests/unit/deployment-contract.test.ts`、`.github/workflows/pr-checks.yml` |
| R2   | 已修复 | 移动项目改用 Pixel 5，因此项目名称、实际 `browserName=chromium` 与 CI 安装项一致                                                                                         | `playwright.config.ts`、`tests/unit/playwright-config.test.ts`                                                                                      |
| R3   | 已修复 | promote/rollback 的 CLI 超时一律视为结果未知；脚本通过固定 project ID 查询平台任务状态，等异步 alias mutation 结束并再次核对正式域名 immutable deployment ID 后才成功    | `scripts/release/common.sh`、`scripts/release/promote.sh`、`scripts/release/rollback.sh`、`tests/unit/release-coordination.test.ts`                 |
| R4   | 已修复 | recovery 可识别“候选已上线但原 GitHub success POST 失败”的 `in_progress` 记录；重新证明 deployment ID、完整 identity 与路由合同后，只重试同一 Deployment 的 success 状态 | `scripts/release/coordinate-recovery.sh`、`scripts/release/deployment-record.sh`、`.github/workflows/production-release.yml`、`doc/operations.md`   |
| R5   | 已修复 | bookmark 与普通富文本共用 Notion 公开集合检查及站内链接重写；快照校验拒绝残留 Notion URL                                                                                 | `scripts/content/notion/convert.ts`、`src/lib/content/validate.ts`、相关转换/校验单测                                                               |
| R6   | 已修复 | 锚点按整篇文章的已分配集合生成，处理重复标题、天然数字后缀和归一化碰撞，并避开 `main-content`；快照校验再次检查唯一性和保留 ID                                           | `src/lib/content/heading.ts`、`scripts/content/notion/convert.ts`、`src/lib/content/validate.ts`                                                    |
| R7   | 已修复 | 目录、锚点和校验共享标题文本规范化；正文 rich-text spans 保持原结构；纯空白标题明确拒绝                                                                                  | `src/lib/content/heading.ts`、转换与内容原语单测                                                                                                    |
| R8   | 已修复 | bookmark caption 作为主链接文本时禁用内部链接语义，避免嵌套 `<a>`；DOM 与浏览器测试覆盖点击目标、键盘焦点和控制台错误                                                    | `src/components/ArticleBody.tsx`、`tests/unit/article-body.test.ts`、`tests/e2e/site.spec.ts`                                                       |
| R9   | 已修复 | 首页、Blog、Publications 和文章页通过共享 helper 显式输出 image、site name、locale、URL；文章使用自身语言与发布时间；E2E 直接断言最终 HTML metadata 合并结果             | `src/lib/metadata.ts`、四个页面 metadata、`tests/unit/metadata.test.ts`、`tests/e2e/site.spec.ts`                                                   |
| R10  | 已修复 | 列表头只由首行与 `hasColumnHeader` 决定，行表头只由首列与 `hasRowHeader` 决定；三种组合有 DOM 级回归测试                                                                 | `src/components/ArticleBody.tsx`、`tests/unit/article-body.test.ts`                                                                                 |

## 复核时追加的防护

- 文章页已经纳入 axe serious/critical 扫描。它实际发现并促成了两项额外修复：display equation 使用 `role="math"`，Shiki 改用 `github-light-high-contrast`，而不是跳过无障碍规则。
- Vercel Project API 请求设置连接和总时限。发布流程在生产上下文检查及每次 alias 状态协调时都 fail-closed 拒绝启用 Rolling Releases 的项目；当前恢复模型只支持原子 alias move，不能把仍在分阶段切流的状态误判为稳定。
- fixture bookmark 刻意包含 caption 自带的第二个链接，用真实渲染路径验证该链接不会产生非法嵌套。

## 本地验收

| 检查                             | 结果                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check`                     | Prettier、ESLint、Next 类型生成、TypeScript、全部 Vitest 单元测试通过                                                       |
| shell / workflow 静态检查        | 所有 release shell 脚本通过 `bash -n`；两份 GitHub Actions YAML 可解析                                                      |
| 发布故障注入                     | 延迟 promotion、rollback CLI 超时、未知状态、Rolling Releases、GitHub success 写入中断后的协调路径均有 fail-closed 回归测试 |
| empty 内容准备、校验与生产构建   | 通过，0 篇文章；这是工作区最终保留的默认生成状态                                                                            |
| fixture 内容准备、校验与生产构建 | 通过，1 篇合成文章；只用于测试，不作为生产内容                                                                              |
| empty 页面 E2E                   | 桌面与移动 Chromium 共 18/18 通过                                                                                           |
| fixture 页面 E2E                 | 桌面与移动 Chromium 共 18/18 通过，包含文章页 metadata、bookmark、console 与 axe                                            |
| empty 部署合同                   | 2/2 通过                                                                                                                    |
| fixture 部署合同                 | 2/2 通过                                                                                                                    |

这些结果验证的是本地已安装依赖和本地 `next start` 生产构建，不等同于真实平台演练。

## 仍需真实账号或平台完成的边界

- 真实 Notion integration、data source schema、分页、长文块、媒体下载与权限；
- GitHub branch protection、Environment reviewer、Deployment 写权限与状态 API；
- Vercel project/scope、Protection、bypass、Rolling Releases 关闭状态、套餐 rollback 能力；
- 正式 DNS、证书、candidate、promote、公开域名验证及 rollback 演练。

在这些条件由账号持有人通过正规控制台确认并完成一次受保护演练前，不能把本地通过表述为已经上线或已经验证生产环境。
