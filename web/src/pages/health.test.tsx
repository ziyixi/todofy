import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BackupStatus } from '../api/types'
import { formatBytes } from '../lib/format'
import { overview } from '../test/fixtures'
import { mockApi, renderApp } from '../test/harness'

function backup(patch: Partial<BackupStatus> = {}): BackupStatus {
  return {
    status: 'ok',
    last_backup_at: '2026-09-27T10:00:41Z',
    last_backup_key: 'backups/2026-09-27T100002Z/',
    last_backup_bytes: 1_843_200,
    last_backup_rows: 52_311,
    last_failure_at: null,
    last_error_code: null,
    next_backup_at: '2026-10-04T10:00:00Z',
    ...patch,
  }
}

describe('health page backup section', () => {
  it('shows the last backup, its size and status', async () => {
    mockApi({ 'GET /api/v1/overview': overview({ backup: backup() }) })
    renderApp('/health')
    const section = await screen.findByRole('region', { name: '备份' })
    expect(within(section).getByText('正常')).toBeInTheDocument()
    expect(section).toHaveTextContent('1.8 MB，52,311 行')
    expect(within(section).getAllByRole('time')[0]).toHaveAttribute('dateTime', '2026-09-27T10:00:41Z')
    expect(section).not.toHaveTextContent('上次失败')
  })

  it('explains a failure newer than the last backup', async () => {
    const failed = backup({ status: 'failed', last_failure_at: '2026-10-04T10:31:00Z', last_error_code: 'lease_expired' })
    mockApi({ 'GET /api/v1/overview': overview({ backup: failed }) })
    renderApp('/health')
    const section = await screen.findByRole('region', { name: '备份' })
    expect(within(section).getByText('失败')).toBeInTheDocument()
    expect(section).toHaveTextContent('30 分钟内没有完成')
  })

  it('says when nothing was backed up yet', async () => {
    const never = backup({ status: 'never', last_backup_at: null, last_backup_key: null })
    mockApi({ 'GET /api/v1/overview': overview({ backup: never }) })
    renderApp('/health')
    const section = await screen.findByRole('region', { name: '备份' })
    expect(section).toHaveTextContent('还没有完成的备份')
    expect(within(section).getByText('尚未备份')).toBeInTheDocument()
  })

  it('omits the section when the overview has no backup field', async () => {
    mockApi({ 'GET /api/v1/overview': overview() })
    renderApp('/health')
    await screen.findByRole('region', { name: 'Worker' })
    expect(screen.queryByRole('region', { name: '备份' })).not.toBeInTheDocument()
  })

  it('formats byte counts in binary units', () => {
    expect([0, 1023, 1024, 1_843_200, 5 * 1024 ** 3].map((value) => formatBytes(value))).toEqual(['0 B', '1023 B', '1 KB', '1.8 MB', '5 GB'])
  })
})
