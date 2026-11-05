import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CopyButton, Modal, formatBytes, formatDate } from '../components/UI';
import { SetupPage } from './SetupPage';
import { createFakeMailHeroServer } from '../test/fakeServer';
import { renderPage } from '../test/fixtures';

describe('SetupPage', () => {
  it('renders receive address, setup checks across statuses, and refreshes on click', async () => {
    const server = createFakeMailHeroServer();
    server.setupStatus = {
      receive_address: 'inbox@mail.example.org',
      last_receive_time: '2026-09-25T10:00:00Z',
      checks: [
        { id: 'edge', label: '邮件路由', result: 'ok', detail: '已配置 Cloudflare Email Routing' },
        { id: 'scheduler', label: '后台调度', result: 'warning', detail: '存在待重试任务' },
        { id: 'dns', label: 'MX 记录', result: 'error', detail: '未检测到记录' },
        { id: 'received', label: '真实收信', result: 'pending', detail: '等待首封测试邮件' },
      ],
    };
    server.install();

    const user = userEvent.setup();
    renderPage(<SetupPage />);

    expect(await screen.findByText('inbox@mail.example.org')).toBeInTheDocument();
    expect(screen.getByText('邮件路由')).toBeInTheDocument();
    expect(screen.getByText('后台调度')).toBeInTheDocument();
    expect(screen.getByText('MX 记录')).toBeInTheDocument();
    expect(screen.getByText('真实收信')).toBeInTheDocument();
    expect(screen.getByText('正常')).toBeInTheDocument();
    expect(screen.getByText('注意')).toBeInTheDocument();
    expect(screen.getByText('异常')).toBeInTheDocument();
    expect(screen.getByText('待确认')).toBeInTheDocument();

    server.setupStatus = {
      receive_address: '',
      checks: [],
    };
    await user.click(screen.getByRole('button', { name: '重新检查' }));

    expect(await screen.findByText('未配置 RECEIVE_ADDRESS')).toBeInTheDocument();
    expect(screen.getByText('尚未收到检查项')).toBeInTheDocument();
  });

  it('shows error banner when setupStatus fails and retries on click', async () => {
    const server = createFakeMailHeroServer();
    let shouldFail = true;
    server.install();
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/setupStatus') && shouldFail) {
        return new Response(
          JSON.stringify({
            error: {
              code: 503,
              message: 'Unavailable',
              status: 'UNAVAILABLE',
              details: [
                { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'UNAVAILABLE', domain: 'mailhero.ui.v2' },
                { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'zh-CN', message: '状态检查暂不可用' },
              ],
            },
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        );
      }
      return originalFetch(input, init);
    });

    const user = userEvent.setup();
    renderPage(<SetupPage />);

    expect(await screen.findByText('读取接入状态失败')).toBeInTheDocument();
    shouldFail = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('inbox@mail.example.org')).toBeInTheDocument();
  });
});

describe('UI primitives and formatters', () => {
  it('copies text via CopyButton and handles clipboard state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const user = userEvent.setup();
    render(<CopyButton text="inbox@mail.example.org" label="复制地址" />);

    const button = screen.getByRole('button', { name: '复制地址' });
    expect(button).toHaveAttribute('data-copied', 'false');
    await user.click(button);

    expect(writeText).toHaveBeenCalledWith('inbox@mail.example.org');
    await waitFor(() => expect(button).toHaveAttribute('data-copied', 'true'));
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument();
  });

  it('traps focus with Tab and Shift+Tab inside Modal and closes on Escape or backdrop mouseDown', () => {
    const onClose = vi.fn();
    render(
      <Modal
        open={true}
        title="确认操作"
        description="键盘焦点测试"
        onClose={onClose}
        footer={<button type="button">确认</button>}
      >
        <input aria-label="输入框" />
      </Modal>,
    );

    const dialog = screen.getByRole('dialog', { name: '确认操作' });
    const closeBtn = screen.getByRole('button', { name: '关闭对话框' });
    const input = screen.getByLabelText('输入框');
    const confirmBtn = screen.getByRole('button', { name: '确认' });

    expect(document.activeElement).toBe(closeBtn);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmBtn);

    confirmBtn.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: false });
    expect(document.activeElement).toBe(closeBtn);

    input.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(dialog);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('formats dates and byte counts across edge cases', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('invalid-date')).toBe('invalid-date');
    expect(formatDate('1969-12-31T23:59:59Z')).toBe('—');
    expect(formatDate('2026-09-25T10:00:00Z')).toMatch(/2026/);

    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2.00 GB');
  });
});
