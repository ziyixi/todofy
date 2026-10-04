import { useState } from 'react'
import type { WebsiteSyncRequestResult, WebsiteSyncStatus } from '../../../worker/src/api-types.ts'
import { newRequestId } from '../api/client'
import { useRequestWebsiteSync } from '../api/queries'
import { httpsUrl } from '../lib/url'
import { Button, Card, Fact, Facts, Notice, Time } from './ui'

const CHECK_STALE_MS = 26 * 60 * 60_000
const OBSERVATION_STALE_MS = 60 * 60_000
const PHASE = {
  queued: '排队中',
  checking: '检查内容中',
  publishing: '发布中',
  unchanged: '内容没有变化',
  published: '已验证发布',
  failed: '同步失败',
  blocked: '同步被阻止',
  unconfirmed: '同步结果尚未确认',
} as const
const ERROR_GUIDANCE: Record<string, string> = {
  sync_check_failed: '读取或核对 Notion 内容失败。请打开本次 Actions，检查 Notion 权限和内容配置，修复后立即同步。',
  sync_build_failed: '网站构建失败。请打开本次 Actions，修复构建错误后立即同步。',
  sync_publish_failed: '发布或线上核验失败。请打开本次 Actions，按重建手册核对线上版本并恢复发布。',
  sync_cancelled: '本次任务已取消。需要更新网站时，点击立即同步。',
  sync_receipt_failed: '同步结果未能登记。请打开本次 Actions，核对内容检查和线上版本，修复回执步骤后立即同步。',
  sync_receipt_missing: '缺少完整同步回执，当前无法确认结果。请打开本次 Actions，核对内容检查和线上版本。',
  sync_gate_blocked: '发布前校验未通过。请打开本次 Actions，处理校验指出的问题后立即同步。',
  sync_bootstrap_required: '网站尚未完成首次初始化。请按重建手册完成网站初始化，再立即同步。',
  github_permission_denied: 'GitHub 权限不足。请核对网站同步凭据的 Actions 读写和 Deployments 读取权限，然后重试。',
  github_unavailable: '暂时无法读取 GitHub。请检查 GitHub 与发布凭据，恢复后刷新控制台。',
  github_response_invalid: 'GitHub 返回的同步记录无法识别。请查看 Actions，并核对同步回执格式。',
  github_dispatch_failed: 'GitHub 没有接受同步请求。请核对仓库、工作流和发布凭据后重试。',
  not_configured: '网站同步凭据尚未配置。请按重建手册设置发布凭据后重试。',
  invalid_configuration: '网站同步配置无效。请核对仓库、工作流和每日检查时间后重新发布。',
}

function errorGuidance(code: string | undefined, fallback: string): string {
  return code ? ERROR_GUIDANCE[code] ?? fallback : fallback
}

function RunLink({ url }: { url: string | undefined }) {
  const safe = httpsUrl(url)
  return safe ? <a href={safe} target="_blank" rel="noreferrer noopener">查看本次 Actions</a> : null
}

function RequestNotice({ request }: { request: WebsiteSyncRequestResult }) {
  switch (request.state) {
    case 'accepted':
      return <Notice tone="info">请求已加入发布队列，尚未完成。 <RunLink url={request.run_url} /></Notice>
    case 'failed':
      return <Notice tone="danger">
        {errorGuidance(request.error_code, 'GitHub 未接受本次同步，请查看发布配置后重试。')}
        {request.error_code ? <code> {request.error_code}</code> : null}
      </Notice>
    case 'unconfirmed':
      return <Notice tone="warn">
        本次请求可能已到达 GitHub。点击“核对本次请求”查找结果，不会重复发送。
        {request.error_code ? <code> {request.error_code}</code> : null}
      </Notice>
  }
}

function ObservationNotice({ status, now }: { status: WebsiteSyncStatus | undefined; now: Date }) {
  if (status === undefined) return <Notice tone="neutral">还没有读取到内容同步记录。网站可访问不代表内容已检查。</Notice>
  if (status.error_code || now.getTime() - Date.parse(status.observed_at) > OBSERVATION_STALE_MS) {
    const retained = status.last_check || status.last_publish || status.latest_attempt
    return <Notice tone="warn">
      同步记录当前无法确认。{retained ? '下方保留上次读取的记录。' : ''}
      {errorGuidance(status.error_code, '请查看 Actions 并刷新控制台。')}
      {status.error_code ? <code> {status.error_code}</code> : null}
    </Notice>
  }
  if (status.last_check && now.getTime() - Date.parse(status.last_check.checked_at) > CHECK_STALE_MS) {
    return <Notice tone="warn">超过 26 小时没有完成内容检查。可立即同步，并查看 Actions 的失败原因。</Notice>
  }
  return null
}

/** Content checks and verified publications have separate clocks; accepting a request advances neither. */
export function WebsiteSyncDetails({ status, now }: { status: WebsiteSyncStatus | undefined; now: Date }) {
  const sync = useRequestWebsiteSync()
  const [requestId, setRequestId] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<WebsiteSyncRequestResult | null>(null)
  const uncertain = requestId !== null && (receipt?.state === 'unconfirmed' || sync.isError)
  const attempt = status?.active_run ?? status?.latest_attempt
  const failed = attempt !== undefined && ['failed', 'blocked', 'unconfirmed'].includes(attempt.state)
  const check = status?.last_check
  const publication = status?.last_publish
  let buttonText = uncertain ? '核对本次请求' : '立即同步'
  if (sync.isPending) buttonText = '正在提交…'

  function requestSync() {
    const id = uncertain ? requestId : newRequestId()
    if (id === null) return
    setRequestId(id)
    setReceipt(null)
    sync.mutate(id, { onSuccess: result => setReceipt(result.request) })
  }

  return <>
    <p className="small muted">每天自动检查 Notion 内容，有变化就发布。Draft 内容保持草稿。</p>
    <ObservationNotice status={status} now={now} />
    {failed ? <Notice tone="warn">
      {errorGuidance(attempt.error_code, `${PHASE[attempt.state]}。请查看本次 Actions，处理错误后立即同步。`)} <RunLink url={attempt.run_url} />
      {attempt.error_code ? <code> {attempt.error_code}</code> : null}
    </Notice> : null}
    <Facts>
      <Fact label="最近完成内容检查">
        {check ? <>
          <Time iso={check.checked_at} now={now} /> · {check.decision === 'unchanged' ? '内容没有变化' : '发现内容变化'}
        </> : '无完整检查记录'}
      </Fact>
      <Fact label="本次任务">
        {attempt ? <>{PHASE[attempt.state]} · <RunLink url={attempt.run_url} /></> : '没有任务记录'}
      </Fact>
      <Fact label="最近验证发布">
        {publication ? <>
          <Time iso={publication.verified_at} now={now} /> · <RunLink url={publication.run_url} />
          <br />
          <span className="small muted">
            版本 <code title={publication.worker_version_id}>{publication.worker_version_id.slice(0, 8)}</code>
            {' · '}代码 <code title={publication.code_sha}>{publication.code_sha.slice(0, 7)}</code>
          </span>
        </> : '无验证发布记录'}
      </Fact>
      <Fact label="下次自动检查">{status ? <Time iso={status.next_check_at} now={now} /> : '尚未读取'}</Fact>
    </Facts>
    <div className="row-wrap">
      <Button onClick={requestSync} disabled={sync.isPending}>{buttonText}</Button>
      <span className="small muted">有任务在执行时，新请求会排队。</span>
    </div>
    {receipt ? <RequestNotice request={receipt} /> : null}
    {sync.isError ? <Notice tone="warn">没有收到请求回执。点击“核对本次请求”查找同一请求，避免重复提交。</Notice> : null}
  </>
}

export function WebsiteSyncPanel({ status, now }: { status: WebsiteSyncStatus | undefined; now: Date }) {
  return <Card title="网站同步" id="website-sync" level={2}>
    <WebsiteSyncDetails status={status} now={now} />
  </Card>
}
