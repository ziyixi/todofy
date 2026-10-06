import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IDS, NOW, analyticsUnavailable, configDrift, driftView, guardShed, healthy, quotaRows, withWorkers, type Scenario } from '../test/fixtures'
import { freezeClock, renderApp, serve, type Call, PATHS } from '../test/harness'

async function showCloudflare(scenario: Scenario | ((call: Call) => Scenario), hash = '#/cloudflare') {
  freezeClock()
  const calls = serve(scenario)
  renderApp(hash)
  await screen.findByRole('heading', { name: '账户额度' })
  return calls
}

const section = (name: string) => screen.getByRole('region', { name })

describe('Cloudflare 监控', () => {
  it('shows the 14 allowances in three groups, with the guard ticks and estimates', async () => {
    await showCloudflare(healthy())
    expect(screen.getByText(/数据来自 Cloudflare GraphQL/)).toHaveTextContent('获取于 00:30（统计日 2026-09-29 UTC） · 最新')
    expect(screen.getByText('用量按整个账户统计，其他项目也算在内。')).toBeInTheDocument()

    const quota = section('账户额度')
    expect(within(quota).getAllByRole('meter')).toHaveLength(14)
    for (const name of ['每日', '每月', '存储']) expect(within(quota).getByRole('region', { name })).toBeInTheDocument()
    const workers = within(quota).getByRole('meter', { name: 'Workers 请求' })
    expect(workers).toHaveAttribute('aria-valuetext', '已用 712 次，上限 100,000 次，0.7%')
    expect(within(quota).getByText(/按当前速度线性估算，本 UTC 日结束约 790 次（0.8%）/)).toBeInTheDocument()
    // Top contributors carry their registry names; unknown scripts stay raw.
    const item = workers.closest('li') as HTMLElement
    expect(within(item).getByText('mail-hero（Mail Hero）')).toBeInTheDocument()
    expect(within(item).getByText('new-worker')).toBeInTheDocument()
  })

  it('names D1, Durable Object and R2 contributors from the registry, never by a bare ID', async () => {
    await showCloudflare(healthy())
    const quota = section('账户额度')
    const itemOf = (name: string) => within(quota).getByRole('meter', { name }).closest('li') as HTMLElement

    const d1 = itemOf('D1 读取行数')
    const mailDb = within(d1).getByText('mail-hero 主库 · Mail Hero')
    expect(mailDb).toHaveAttribute('title', IDS.mailHeroDb)
    expect(mailDb.tagName).toBe('SPAN')
    const unknownDb = within(d1).getByText('未登记 · 8f14e45f')
    expect(unknownDb).toHaveAttribute('title', IDS.unknownDb)
    expect(unknownDb).toHaveClass('muted')
    expect(d1).not.toHaveTextContent(IDS.mailHeroDb)

    const doRows = itemOf('Durable Objects SQLite 写入行数')
    expect(within(doRows).getByText('MailCoordinator · Mail Hero')).toHaveAttribute('title', IDS.mailCoordinator)
    expect(within(doRows).getByText('TodofyCore · Todofy')).toBeInTheDocument()
    expect(within(doRows).getByText('HomeState · 个人控制台')).toBeInTheDocument()
    expect(within(doRows).getByText('未登记 · 01234567')).toHaveAttribute('title', IDS.unknownNs)
    expect(doRows).not.toHaveTextContent('a87ff679')

    // DO requests are counted per script: named like the Worker rows.
    const doRequests = itemOf('Durable Objects 请求')
    expect(within(doRequests).getByText('mail-hero（Mail Hero）')).toBeInTheDocument()
    expect(within(doRequests).getByText('todofy-core（Todofy）')).toBeInTheDocument()

    // A bucket: its registry name, the bucket name as the tooltip; an unregistered one in full.
    const r2 = itemOf('R2 存储')
    expect(within(r2).getByText('mail-hero 邮件存储 · Mail Hero')).toHaveAttribute('title', 'mail-hero-store')
    expect(within(r2).getByText('todofy 备份 · Todofy')).toBeInTheDocument()
    expect(within(r2).getByText('未登记 · scratch-bucket')).toBeInTheDocument()
  })

  it('words an unregistered ID the same in the resource table and in 主要来源 (UX-1)', async () => {
    await showCloudflare(healthy())
    const view = document.body
    // Both places: one wording, "未登记 · <first 8>", the full ID as the tooltip.
    for (const [id, text] of [
      [IDS.unknownDb, '未登记 · 8f14e45f'],
      [IDS.unknownNs, '未登记 · 01234567'],
    ] as const) {
      const shown = within(view).getAllByText(text)
      expect(shown.length, text).toBeGreaterThanOrEqual(2)
      expect(shown.some((el) => el.closest('.breakdown') !== null), text).toBe(true)
      expect(shown.some((el) => el.closest('.res') !== null), text).toBe(true)
      for (const el of shown) expect(el).toHaveAttribute('title', id)
    }
    expect(within(view).queryByText(/^未登记 [^·]/)).toBeNull()
  })

  it('reads a D1, DO or R2 contributor measured without its identifier as 未归类, never as unknown (UX-2)', async () => {
    const base = healthy()
    const unclassified = (kind: 'd1' | 'do' | 'r2', value: number) => ({ name: 'unknown', value, kind })
    const rows = quotaRows({
      d1_rows_written: { breakdown: [{ name: IDS.mailHeroDb, value: 300, kind: 'd1', resource: 'mail-hero-db' }, unclassified('d1', 18)] },
      do_rows_read: { breakdown: [unclassified('do', 40)] },
      r2_class_a: { breakdown: [{ name: 'mail-hero-store', value: 900, kind: 'r2', resource: 'mail-hero-store' }, unclassified('r2', 4)] },
    })
    await showCloudflare({ ...base, cloudflare: { ...base.cloudflare, usage: { ...base.cloudflare.usage, rows } } })
    const quota = section('账户额度')
    const itemOf = (name: string) => within(quota).getByRole('meter', { name }).closest('li') as HTMLElement
    const d1 = within(itemOf('D1 写入行数')).getByText('未归类')
    expect(d1).toHaveAttribute('title', 'unknown')
    expect(d1.tagName).toBe('SPAN')
    expect(d1).not.toHaveClass('muted')
    expect(within(itemOf('Durable Objects SQLite 读取行数')).getByText('未归类')).toBeInTheDocument()
    // R2: the table's wording for operations without a bucket.
    expect(within(itemOf('R2 A 类操作')).getByText('未归类操作')).toHaveAttribute('title', 'unknown')
    expect(within(quota).queryByText('unknown')).toBeNull()
    // The value keeps its own non-wrapping cell next to the name (UX-3).
    expect(within(itemOf('D1 写入行数')).getByText('18 行')).toHaveClass('breakdown-value')
    expect(within(section('存储与资源')).getByText('未归类操作')).toBeInTheDocument()
  })

  it('still shows a breakdown stored before the resource join by its raw key', async () => {
    const base = healthy()
    const rows = quotaRows({ d1_rows_read: { breakdown: [{ name: IDS.mailHeroDb, value: 5_210 }] } })
    await showCloudflare({ ...base, cloudflare: { ...base.cloudflare, usage: { ...base.cloudflare.usage, rows } } })
    const item = within(section('账户额度')).getByRole('meter', { name: 'D1 读取行数' }).closest('li') as HTMLElement
    expect(within(item).getByText(IDS.mailHeroDb).tagName).toBe('CODE')
  })

  it('shows Workers AI neurons as a daily row with the neurons left, its top models and no guard', async () => {
    await showCloudflare(healthy())
    const daily = within(section('账户额度')).getByRole('region', { name: '每日' })
    expect(within(daily).getByText(/每天 00:00 UTC 重置/)).toHaveTextContent('每天 00:00 UTC 重置，计入自动降载（Workers AI neurons 除外）')
    const meter = within(daily).getByRole('meter', { name: 'Workers AI neurons' })
    expect(meter).toHaveAttribute('aria-valuetext', '已用 300 neurons，上限 10,000 neurons，3%，剩余 9,700 neurons')
    const item = meter.closest('li') as HTMLElement
    expect(item).toHaveClass('quota-ok')
    expect(within(item).getByText('剩余 9,700 neurons')).toHaveClass('quota-remaining')
    expect(within(item).getByText('估算与主要来源')).toBeInTheDocument()
    expect(within(item).getByText('@cf/meta/llama-3.1-8b-instruct')).toBeInTheDocument()
    expect(within(item).getByText('225 neurons')).toBeInTheDocument()
    expect(within(item).getByText(/本 UTC 日结束约 423.5 neurons（4.2%）/)).toBeInTheDocument()
    expect(within(item).getByRole('link', { name: /限额说明/ })).toHaveAttribute('href', 'https://developers.cloudflare.com/workers-ai/platform/pricing/')
    // No other row states a remainder.
    expect(within(section('账户额度')).getAllByText(/^剩余 /)).toHaveLength(1)
  })

  it('reads a day without AI calls as 0 used with everything left, and a high one as a warning that never sheds', async () => {
    const base = healthy()
    const idle = quotaRows({ ai_neurons: { used: 0, projected: 0, projected_percent: 0, breakdown: [] } })
    await showCloudflare({ ...base, cloudflare: { ...base.cloudflare, usage: { ...base.cloudflare.usage, rows: idle } } })
    const meter = within(section('账户额度')).getByRole('meter', { name: 'Workers AI neurons' })
    expect(meter).toHaveAttribute('aria-valuetext', '已用 0 neurons，上限 10,000 neurons，0%，剩余 10,000 neurons')
    expect(within(meter.closest('li') as HTMLElement).getByText('0 neurons / 10,000 neurons')).toBeInTheDocument()
    expect(within(meter.closest('li') as HTMLElement).getByText('剩余 10,000 neurons')).toBeInTheDocument()
    expect(meter.closest('li')).not.toHaveTextContent('无数据')
  })

  it('warns on Workers AI at 80 % but never names it as the guard\'s highest trigger', async () => {
    const base = healthy()
    const high = quotaRows({ ai_neurons: { used: 9_650.4, projected: null, projected_percent: null } })
    await showCloudflare({ ...base, cloudflare: { ...base.cloudflare, usage: { ...base.cloudflare.usage, rows: high } } })
    const item = within(section('账户额度')).getByRole('meter', { name: 'Workers AI neurons' }).closest('li') as HTMLElement
    expect(item).toHaveClass('quota-danger')
    expect(within(item).getByText('超过 95%')).toBeInTheDocument()
    // Rounded down: 349.6 left reads 349, never more than there is.
    expect(within(item).getByText('剩余 349 neurons')).toBeInTheDocument()
    const guard = section('非关键后台工作')
    expect(guard).toHaveTextContent('未降载')
    expect(guard).not.toHaveTextContent('Workers AI')
  })

  it('marks a quota row by its measured value, as the guard does: 79.95 % reads 80 % but is below it (C3)', async () => {
    const base = healthy()
    const rows = quotaRows({ d1_rows_read: { used: 3_997_500 }, d1_rows_written: { used: 80_000 } })
    await showCloudflare({ ...base, cloudflare: { ...base.cloudflare, usage: { ...base.cloudflare.usage, rows } } })
    const quota = section('账户额度')
    const read = within(quota).getByRole('meter', { name: 'D1 读取行数' })
    expect(read).toHaveAttribute('aria-valuenow', '80')
    const readItem = read.closest('li') as HTMLElement
    expect(readItem).toHaveClass('quota-ok')
    expect(within(readItem).queryByText('超过 80%')).toBeNull()
    const written = within(quota).getByRole('meter', { name: 'D1 写入行数' }).closest('li') as HTMLElement
    expect(written).toHaveClass('quota-warn')
    expect(within(written).getByText('超过 80%')).toBeInTheDocument()
  })

  it('lists the discovered Workers with owner, flows, errors and CPU against 10 ms', async () => {
    await showCloudflare(healthy())
    const table = within(section('Worker · 5 个（自动发现）')).getByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('rowheader')[0]?.textContent)).toEqual([
      'todofy',
      'ziyixi-notion-publish',
      'mail-hero',
      'home',
      'todofy-core',
      '合计',
    ])
    const todofy = rows[0] as HTMLElement
    expect(within(todofy).getByText('Todofy')).toBeInTheDocument()
    expect(within(todofy).getAllByText(/^(邮件 → 任务|每日 Newsletter|运维摘要)$/).map((tag) => tag.textContent)).toEqual([
      '邮件 → 任务',
      '每日 Newsletter',
      '运维摘要',
    ])
    expect(within(todofy).getByText('2 · 0.9%')).toBeInTheDocument()
    expect(within(todofy).getByRole('img', { name: 'CPU p99 3.6 ms，Free 上限 10 ms' })).toBeInTheDocument()

    const notion = rows[1] as HTMLElement
    expect(within(notion).getByText('样本太少（< 20 次），不判定', { selector: '.cell-note' })).toBeInTheDocument()
    expect(within(notion).getByRole('img', { name: 'CPU p99 8.4 ms，Free 上限 10 ms，接近上限' })).toBeInTheDocument()
    expect(within(notion).getByText('接近 Free 10 ms')).toBeInTheDocument()

    expect(within(rows[2] as HTMLElement).getByText('612', { selector: 'td' })).toBeInTheDocument()
    expect(within(rows[3] as HTMLElement).getByText('个人控制台')).toBeInTheDocument()
    const total = rows[5] as HTMLElement
    expect(within(total).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['', '712', '3', '', '213', '1,380', '', ''])
  })

  it('re-sorts the Worker table by its headers; errors first is the default (F11)', async () => {
    await showCloudflare(healthy())
    const table = within(section('Worker · 5 个（自动发现）')).getByRole('table')
    const names = () => within(table).getAllByRole('row').slice(1, -1).map((row) => within(row).getAllByRole('rowheader')[0]?.textContent)
    const header = (name: string) => within(table).getByRole('columnheader', { name: new RegExp(`^${name}`) })
    expect(header('错误')).toHaveAttribute('aria-sort', 'descending')
    expect(header('今日请求')).toHaveAttribute('aria-sort', 'none')
    const user = userEvent.setup()
    await user.click(within(header('今日请求')).getByRole('button'))
    expect(header('今日请求')).toHaveAttribute('aria-sort', 'descending')
    expect(header('错误')).toHaveAttribute('aria-sort', 'none')
    expect(names()).toEqual(['mail-hero', 'todofy', 'home', 'todofy-core', 'ziyixi-notion-publish'])
    await user.click(within(header('今日请求')).getByRole('button'))
    expect(header('今日请求')).toHaveAttribute('aria-sort', 'ascending')
    expect(names()[0]).toBe('ziyixi-notion-publish')
    await user.click(within(header('CPU')).getByRole('button'))
    expect(names()[0]).toBe('ziyixi-notion-publish')
  })

  it('keeps a phone card to two lines: the rest of a Worker is behind 更多 (F9)', async () => {
    await showCloudflare(healthy())
    const table = within(section('Worker · 5 个（自动发现）')).getByRole('table')
    const todofy = within(table).getAllByRole('row')[1] as HTMLElement
    const more = within(todofy).getByText('更多', { selector: 'summary' }).closest('details') as HTMLElement
    expect(more).not.toHaveAttribute('open')
    expect(within(more).getByText('子请求').nextElementSibling).toHaveTextContent(/^\d/)
    expect(within(more).getByText('流程').nextElementSibling).toHaveTextContent('邮件 → 任务、每日 Newsletter、运维摘要')
  })

  it('keeps quota rows compact: an estimate is behind a disclosure unless it reaches 80 % (F9)', async () => {
    const base = healthy()
    const rows = base.cloudflare.usage.rows.map((row) =>
      row.id === 'd1_rows_written' ? { ...row, projected: 90_000, projected_percent: 90 } : row,
    )
    await showCloudflare({ ...base, cloudflare: { ...base.cloudflare, usage: { ...base.cloudflare.usage, rows } } })
    const quota = section('账户额度')
    const quiet = within(quota).getByText(/按当前速度线性估算，本 UTC 日结束约 790 次/)
    expect(quiet.closest('details')).not.toBeNull()
    const urgent = within(quota).getByText(/按当前速度线性估算，本 UTC 日结束约 90,000 行/)
    expect(urgent.closest('details')).toBeNull()
  })

  it('shows an empty table honestly with no Workers', async () => {
    await showCloudflare(withWorkers(0))
    const empty = section('Worker · 0 个（自动发现）')
    expect(within(empty).queryByRole('table')).toBeNull()
    expect(within(empty).getByText('今天还没有 Worker 的请求数据。新 Worker 第一次有请求就会出现在这里。')).toBeInTheDocument()
  })

  it('lists 20 Workers, each unregistered one marked 未登记', async () => {
    await showCloudflare(withWorkers(20))
    const table = within(section('Worker · 20 个（自动发现）')).getByRole('table')
    expect(within(table).getAllByRole('row')).toHaveLength(22)
    expect(within(table).getAllByText('未登记')).toHaveLength(20)
  })

  it('says how many remembered Workers the capped table leaves out (C2)', async () => {
    const base = withWorkers(20)
    await showCloudflare({ ...base, cloudflare: { ...base.cloudflare, workers_omitted: 7 } })
    expect(screen.getByText(/另有 7 个近 30 天出现过的 Worker 未列出/)).toHaveTextContent(
      '另有 7 个近 30 天出现过的 Worker 未列出：今天有请求的全部在表中，其余按最近出现时间列出前 20 个。',
    )
  })

  it('explains unavailable analytics without inventing numbers', async () => {
    await showCloudflare(analyticsUnavailable())
    expect(screen.getByText(/数据来自 Cloudflare GraphQL/)).toHaveTextContent('还没有成功获取过用量数据 · 无法获取')
    expect(screen.getByText(/获取用量失败：HTTP 401：令牌无效或权限不足（连续 5 次）/)).toBeInTheDocument()
    expect(screen.getByText(/没有最新用量时不会自动进入降载。/)).toBeInTheDocument()
    expect(within(section('账户额度')).queryAllByRole('meter')).toHaveLength(0)
    expect(within(section('Worker · 0 个（自动发现）')).getByText('用量数据无法获取，暂时没有 Worker 的指标。')).toBeInTheDocument()
  })

  it('names registered resources and shows the rest as 未登记 with their ID prefix', async () => {
    await showCloudflare(healthy())
    const resources = section('存储与资源')
    const d1 = within(resources).getByRole('region', { name: 'D1 数据库' })
    expect(within(d1).getByText('未登记 · 8f14e45f')).toBeInTheDocument()
    expect(within(d1).getByText('38.9 MB')).toBeInTheDocument()
    const durable = within(resources).getByRole('region', { name: 'Durable Objects' })
    expect(within(durable).getByText('未登记 · 01234567')).toBeInTheDocument()
    expect(within(durable).getByText('存储只有账户总量（12.4 MB），见上方“存储”额度。')).toBeInTheDocument()
    const r2 = within(resources).getByRole('region', { name: 'R2 存储桶' })
    expect(within(r2).getByText('mail-hero 邮件存储')).toBeInTheDocument()
    expect(within(r2).getByText('未归类操作')).toBeInTheDocument()
  })

  it('shows an unregistered R2 bucket by its full name, so shared prefixes stay apart (F10)', async () => {
    const base = healthy()
    const resources = [
      ...base.cloudflare.resources,
      { kind: 'r2' as const, id: 'mail-hero-backup', resource: null, entry: null, size_bytes: 1_000, requests: null, class_a: 1, class_b: 1 },
      { kind: 'r2' as const, id: 'mail-hero-backup-old', resource: null, entry: null, size_bytes: 1_000, requests: null, class_a: 1, class_b: 1 },
    ]
    await showCloudflare({ ...base, cloudflare: { ...base.cloudflare, resources } })
    const r2 = within(section('存储与资源')).getByRole('region', { name: 'R2 存储桶' })
    expect(within(r2).getByText('未登记 · mail-hero-backup')).toBeInTheDocument()
    expect(within(r2).getByText('未登记 · mail-hero-backup-old')).toBeInTheDocument()
  })

  it('names the backup bucket of the self-hosted servers VPS 备份 under 自托管服务器, not 未登记', async () => {
    const base = healthy()
    const resources = [
      ...base.cloudflare.resources,
      { kind: 'r2' as const, id: 'vultr-backup', resource: 'vps-backup', entry: 'self-hosted', size_bytes: 790_000_000, requests: null, class_a: 12, class_b: 3 },
    ]
    await showCloudflare({ ...base, cloudflare: { ...base.cloudflare, resources } })
    const r2 = within(section('存储与资源')).getByRole('region', { name: 'R2 存储桶' })
    const row = within(r2).getByText('VPS 备份').closest('tr') as HTMLElement
    expect(row).not.toHaveClass('row-muted')
    expect(within(row).getByText('自托管服务器')).toBeInTheDocument()
    expect(within(row).getByText('790 MB')).toBeInTheDocument()
    expect(within(r2).queryByText(/vultr-backup/)).toBeNull()
  })

  it('shows 配置漂移 as ok with when it was checked and what it compares', async () => {
    await showCloudflare(healthy())
    const drift = section('配置漂移')
    expect(within(drift).getByText('与代码一致')).toBeInTheDocument()
    expect(within(drift).getByText(/上次完成检查/)).toBeInTheDocument()
    expect(within(drift).getByText(/每天 02:00 UTC 起检查一次 7 个 Worker/)).toBeInTheDocument()
    expect(within(drift).getByText(/不读取、不显示任何值/)).toBeInTheDocument()
    expect(within(drift).getByRole('list', { name: '各类差异' })).toHaveTextContent('个人值未设为密钥 0')
  })

  it('lists each drift finding by category, Worker and name, and the strip points here', async () => {
    await showCloudflare(configDrift())
    const drift = section('配置漂移')
    expect(within(drift).getByText('与代码不一致：4 处')).toBeInTheDocument()
    const items = within(drift).getAllByRole('listitem').filter((li) => li.closest('.drift-findings'))
    expect(items.map((li) => li.textContent)).toEqual([
      'Workersynthetic-orphan线上有，代码中没有',
      '自定义域名homestray.example.com线上有，代码中没有',
      '绑定与密钥watchSYNTHETIC_KEY代码中有（secret_text），线上没有',
      '个人值未设为密钥mail-heroSYNTHETIC_PERSONAL应为密钥（secret_text），线上为 plain_text',
    ])
    expect(screen.getAllByText(/线上配置与代码不一致/).length).toBeGreaterThan(0)
  })

  it('says when the drift check fails, keeps the last result, and when no token is configured', async () => {
    const failing = healthy()
    failing.cloudflare = {
      ...failing.cloudflare,
      drift: driftView({ last_error: 'http_403', last_error_step: 'script', last_error_at: '2026-09-29T03:30:00.000Z', consecutive_failed_days: 2 }),
    }
    await showCloudflare(failing)
    const drift = section('配置漂移')
    expect(within(drift).getByText(/检查失败：HTTP 403：令牌无效或权限不足（连续 2 天）/)).toBeInTheDocument()
    expect(within(drift).getByText(/下方为上次完成的检查结果/)).toBeInTheDocument()
  })

  it('says 未配置令牌 for the drift check without the token', async () => {
    const none = healthy()
    none.cloudflare = { ...none.cloudflare, drift: driftView({ status: 'not_configured', checked_at: null }) }
    await showCloudflare(none)
    const drift = section('配置漂移')
    expect(within(drift).getByText('未配置令牌')).toBeInTheDocument()
    expect(within(drift).queryByRole('list', { name: '各类差异' })).toBeNull()
  })

  it('shows the guard read-only with a link to its actions', async () => {
    await showCloudflare(guardShed())
    const guard = section('非关键后台工作')
    expect(guard).toHaveTextContent('降载中')
    expect(guard).toHaveTextContent('配额：D1 读取行数')
    expect(guard).toHaveTextContent('80% 自动降载 / 70% 解除')
    expect(guard).toHaveTextContent('Mail Hero 已生效')
    expect(guard).toHaveTextContent('Todofy 已生效（上次下发失败）')
    expect(within(guard).getByRole('link', { name: '按服务调整 →' })).toHaveAttribute('href', '#/ops')
    expect(within(guard).queryByRole('button')).toBeNull()
  })

  it('refreshes the usage through RefreshCloudflareView and says when it was too soon', async () => {
    let refreshed = true
    const base = healthy()
    const calls = await showCloudflare((call) => ({
      ...base,
      cloudflare: {
        ...base.cloudflare,
        usage: { ...base.cloudflare.usage, rows: quotaRows({ workers_requests: { used: 800 } }) },
        // A declined refresh answers with the Worker's next window (60 s here).
        refresh: { ...base.cloudflare.refresh, refreshed, next_refresh_at: !refreshed && call.path.endsWith(':refresh') ? new Date(NOW.getTime() + 60_000).toISOString() : NOW.toISOString() },
      },
    }))
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: '刷新用量' })
    expect(button).toHaveAccessibleDescription('至少间隔 60 秒')
    await user.click(button)
    await waitFor(() => expect(screen.getByText('用量已刷新。')).toHaveAttribute('role', 'status'))
    expect(calls.map((call) => call.path)).toContain(PATHS.refreshCloudflare)
    expect(within(section('账户额度')).getByRole('meter', { name: 'Workers 请求' })).toHaveAttribute('aria-valuetext', '已用 800 次，上限 100,000 次，0.8%')

    refreshed = false
    await user.click(screen.getByRole('button', { name: '刷新用量' }))
    await waitFor(() => expect(screen.getByText('刚刚刷新过，请在 1 分钟后再试。')).toBeInTheDocument())
  })

  it('keeps the refresh button disabled until the Worker allows the next one', async () => {
    const base = healthy()
    await showCloudflare({
      ...base,
      cloudflare: { ...base.cloudflare, refresh: { ...base.cloudflare.refresh, next_refresh_at: new Date(NOW.getTime() + 30_000).toISOString() } },
    })
    const button = screen.getByRole('button', { name: '刷新用量' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription('1 分钟后可再次刷新')
  })

  it('highlights the Worker named in the route', async () => {
    await showCloudflare(healthy(), '#/cloudflare/worker/todofy-core')
    const row = document.getElementById('worker-todofy-core') as HTMLElement
    expect(row).toHaveAttribute('aria-current', 'true')
  })

  it('says when the Worker named in the route has no data', async () => {
    await showCloudflare(healthy(), '#/cloudflare/worker/old-worker')
    expect(screen.getByText(/没有 Worker/)).toHaveTextContent('没有 Worker old-worker 的数据：它最近 30 天没有请求，或还没有被发现。')
  })
})
