// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from '@ziyixi/proto/protobuf'
import { Code } from '@ziyixi/proto/rpc-status'
import { SetupCheck_Result, SetupCheckSchema, SetupStatusSchema } from '@ziyixi/proto/mailhero/ui/v2/settings_pb'
import { timestamp } from '../api/client'
import { CopyButton, Modal, formatBytes, formatDate } from '../components/UI'
import { installFakeServer, rpcError } from '../test/fakeServer'
import { renderAt, settings } from '../test/fixtures'
import SetupPage from './SetupPage'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('SetupPage', () => {
  it('renders receive address, setup checks across statuses, and refreshes on click', async () => {
    const fake = installFakeServer({
      settings: settings({ receiveAddress: 'inbox@mail.example.org' }),
      setup: create(SetupStatusSchema, {
        name: 'setupStatus',
        receiveAddress: 'inbox@mail.example.org',
        lastReceiveTime: timestamp('2026-09-25T10:00:00Z'),
        checks: [
          create(SetupCheckSchema, { id: 'edge', label: '邮件路由', result: SetupCheck_Result.OK, detail: '已配置 Cloudflare Email Routing' }),
          create(SetupCheckSchema, { id: 'scheduler', label: '后台调度', result: SetupCheck_Result.WARNING, detail: '存在待重试任务' }),
          create(SetupCheckSchema, { id: 'dns', label: 'MX 记录', result: SetupCheck_Result.ERROR, detail: '未检测到记录' }),
          create(SetupCheckSchema, { id: 'received', label: '真实收信', result: SetupCheck_Result.PENDING, detail: '等待首封测试邮件' }),
        ],
      }),
    })

    renderAt(<SetupPage />, '/setup')

    expect((await screen.findAllByText('inbox@mail.example.org')).length).toBeGreaterThan(0)
    expect(await screen.findByText('邮件路由')).toBeTruthy()
    expect(screen.getByText('后台调度')).toBeTruthy()
    expect(screen.getByText('MX 记录')).toBeTruthy()
    expect(screen.getByText('真实收信')).toBeTruthy()

    fake.state.settings = settings({ receiveAddress: '' })
    fake.state.setup = create(SetupStatusSchema, {
      name: 'setupStatus',
      receiveAddress: '',
      checks: [],
    })
    fireEvent.click(screen.getByRole('button', { name: /重新检测/ }))

    expect(await screen.findByText('尚未配置收信地址')).toBeTruthy()
    expect(await screen.findByText(/尚无检测结果/)).toBeTruthy()
  })

  it('shows error banner when setupStatus fails and retries on click', async () => {
    const fake = installFakeServer({
      settings: settings({ receiveAddress: 'inbox@mail.example.org' }),
      setup: create(SetupStatusSchema, {
        name: 'setupStatus',
        receiveAddress: 'inbox@mail.example.org',
        checks: [
          create(SetupCheckSchema, { id: 'edge', label: '邮件路由', result: SetupCheck_Result.OK, detail: '已配置 Cloudflare Email Routing' }),
        ],
      }),
    })
    fake.fail.getSetupStatus = rpcError(Code.UNAVAILABLE, 'UNAVAILABLE')

    renderAt(<SetupPage />, '/setup')

    expect((await screen.findAllByText('无法加载内容')).length).toBeGreaterThan(0)
    delete fake.fail.getSetupStatus
    fireEvent.click(screen.getAllByRole('button', { name: /重试/ })[0])
    expect(await screen.findByText('邮件路由')).toBeTruthy()
  })
})

describe('UI primitives and formatters', () => {
  it('copies text via CopyButton and handles clipboard state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })

    render(<CopyButton value="inbox@mail.example.org" label="复制地址" />)

    const button = screen.getByRole('button', { name: '复制地址' })
    button.focus()
    fireEvent.click(button)

    expect(writeText).toHaveBeenCalledWith('inbox@mail.example.org')
    await waitFor(() => expect(button.dataset.copied).toBe('true'))
  })

  it('traps focus with Tab and Shift+Tab inside Modal and closes on Escape or backdrop mouseDown', () => {
    const onClose = vi.fn()
    render(
      <Modal
        title="确认操作"
        onClose={onClose}
        footer={<button type="button">确认</button>}
      >
        <button type="button">取消</button>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog', { name: '确认操作' })
    const closeBtn = screen.getByRole('button', { name: '关闭对话框' })
    const cancelBtn = screen.getByRole('button', { name: '取消' })
    const confirmBtn = screen.getByRole('button', { name: '确认' })

    expect(document.activeElement).toBe(closeBtn)

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirmBtn)

    confirmBtn.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: false })
    expect(document.activeElement).toBe(closeBtn)

    cancelBtn.focus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(dialog.parentElement!)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('formats dates and byte counts across edge cases', () => {
    expect(formatDate(null)).toBe('—')
    expect(formatDate(undefined)).toBe('—')
    expect(formatDate('invalid-date')).toBe('invalid-date')
    expect(formatDate('1969-12-31T23:59:59Z')).toBe('—')
    expect(formatDate('2026-09-25T10:00:00Z')).toMatch(/2026/)

    expect(formatBytes(null)).toBe('—')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00 GB')
  })
})

