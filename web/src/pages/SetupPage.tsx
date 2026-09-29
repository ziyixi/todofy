import { CircleCheck, CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSetup } from '../api/queries'
import type { Setup } from '../api/types'
import { CopyButton, ErrorPanel, Facts, Loading, PageHeader, Section } from '../components/ui'

const SECRETS: [keyof Setup['configured'], string, string][] = [
  ['mail_webhook_token', 'MAIL_WEBHOOK_TOKEN_SHA256', 'Mail Hero webhook 的 Bearer token 摘要'],
  ['report_basic_auth', 'REPORT_BASIC_AUTH_SHA256', 'newsletter Basic 认证的摘要'],
  ['gemini_api_key', 'GEMINI_API_KEY', '生成摘要与日报'],
  ['todoist_api_key', 'TODOIST_API_KEY', '建任务与只读页脚查找'],
  ['todoist_project', 'TODOIST_DEFAULT_PROJECT_ID', '任务所在的 Todoist 项目'],
]

function Copyable({ value, label }: { value: string; label: string }) {
  return (
    <span className="inline-copy">
      <code className="wrap">{value}</code>
      <CopyButton value={value} label={label} />
    </span>
  )
}

function Command({ children }: { children: string }) {
  return (
    <div className="command">
      <pre className="pre">{children}</pre>
      <CopyButton value={children} label="命令" />
    </div>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="steps">{children}</ol>
}

export function SetupPage() {
  const setup = useSetup()

  return (
    <>
      <PageHeader title="设置" description="接入 Mail Hero 与 newsletter 所需的信息。这里只显示密钥是否已配置，从不显示密钥本身。" />
      {setup.isPending ? (
        <Loading />
      ) : setup.isError ? (
        <ErrorPanel error={setup.error} onRetry={() => setup.refetch()} />
      ) : (
        <div className="stack">
          <Section title="接入地址">
            <Facts
              items={[
                ...setup.data.hooks_hosts.map((host, index): [ReactNode, ReactNode] => [
                  index === 0 ? 'Webhook 地址' : '备用地址',
                  <Copyable key={host} value={`https://${host}${setup.data.webhook_path}`} label="Webhook 地址" />,
                ]),
                ['管理界面', <Copyable key="p" value={`https://${setup.data.public_host}`} label="管理界面地址" />],
                ['邮件来源 ID', <code key="s">{setup.data.mail_source_id}</code>],
                ['Access 所有者', <code key="o">{setup.data.access_owner}</code>],
                ['部署版本', <code key="b">{setup.data.build.slice(0, 12) || '未设置'}</code>],
              ]}
            />
          </Section>

          <Section title="密钥与配置">
            <ul className="check-list">
              {SECRETS.map(([key, name, purpose]) => {
                const ok = setup.data.configured[key]
                return (
                  <li key={key} className={ok ? 'tone-ok' : 'tone-danger'}>
                    {ok ? <CircleCheck size={18} aria-hidden="true" /> : <CircleAlert size={18} aria-hidden="true" />}
                    <span>
                      <code>{name}</code>
                      <span className="muted small">
                        {purpose} · {ok ? '已配置' : '未配置'}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </Section>

          <Section title="在 Mail Hero 添加目标">
            <Steps>
              <li>确认上面的 webhook 主机名已在 Mail Hero 的 WEBHOOK_ALLOWED_HOSTS 中。</li>
              <li>
                在本机终端生成一个随机 token，它只保存在 Mail Hero 目标里：
                <Command>{`TOKEN=$(openssl rand -hex 32); printf '%s\\n' "$TOKEN"`}</Command>
              </li>
              <li>
                在同一终端计算它的 SHA-256，写入 Worker secret MAIL_WEBHOOK_TOKEN_SHA256：
                <Command>{"printf '%s' \"$TOKEN\" | shasum -a 256"}</Command>
              </li>
              <li>在 Mail Hero 新建 HTTPS 目标：URL 填 webhook 地址，认证选 Bearer，填入 token。</li>
              <li>
                Mail Hero 的“测试”会真的投递一条合成事件：Todofy 会为它生成摘要并在 Todoist 建一条任务，确认后可在 Todoist
                删除。
              </li>
            </Steps>
          </Section>

          <Section title="轮换 webhook token">
            <Steps>
              <li>把当前摘要移到 MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS，把新 token 的摘要写入 MAIL_WEBHOOK_TOKEN_SHA256。</li>
              <li>在 Mail Hero 目标里换成新 token，确认下一次投递成功（事件页出现新事件）。</li>
              <li>删除 MAIL_WEBHOOK_TOKEN_SHA256_PREVIOUS。</li>
            </Steps>
          </Section>

          <Section title="访问控制">
            <Steps>
              <li>管理界面的整个主机名都在 Cloudflare Access 之后；Worker 还会为每个请求再次校验 Access JWT 与所有者邮箱。</li>
              <li>同一人在其他登录方式下的邮箱写进 ACCESS_OWNER_ALIASES（最多 8 个），它们都等同于所有者。</li>
              <li>
                Webhook 与 newsletter 主机名不在 Access 之后：webhook 用 Bearer token，/api/summary 与 /api/recommendation 用
                Basic 认证（REPORT_BASIC_AUTH_SHA256 存 “用户名:密码” 的 SHA-256）；每个 UTC 小时 20 次认证失败后当小时返回 429。
              </li>
            </Steps>
          </Section>
        </div>
      )}
    </>
  )
}
