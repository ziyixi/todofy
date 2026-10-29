import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { setup } from '../test/fixtures';
import { apiError, mockApi, renderApp } from '../test/harness';

describe('model settings', () => {
  it('shows separate Codex and OpenAI API choices and saves both routes without computing content', async () => {
    const user = userEvent.setup();
    let settings = { name: 'modelSettings', email_model: 'gpt-6.1-sol', report_model: 'gemini-3.8-flash', etag: '1' };
    const models = [
      { id: 'gpt-6.1-sol', display_name: 'Sol 6.1', provider: 'codex', configured: true, kind: 'text' },
      { id: 'openai/gpt-6.1-sol', display_name: 'Sol 6.1', provider: 'openai', configured: true, kind: 'text' },
      { id: 'gemini-3.8-flash', provider: 'google', configured: true, kind: 'text' },
      { id: 'openai/gpt-6-astra', provider: 'openai', configured: false, kind: 'text' },
    ];
    const { calls } = mockApi({
      'GET /api/v1/integration': setup(),
      'GET /api/v1/modelSettings': () => ({ settings, models }),
      'PATCH /api/v1/modelSettings': (call) => { settings = { ...settings, ...call.body as object, etag: '2' }; return settings; },
    });
    const view = renderApp('/setup');
    const mail = await screen.findByLabelText('逐封邮件摘要');
    expect(screen.getAllByRole('option', { name: /Sol 6.1 · Codex 订阅/ })).toHaveLength(2);
    expect(screen.getAllByRole('option', { name: /Sol 6.1 · OpenAI API/ })).toHaveLength(2);
    expect(screen.getAllByRole('option', { name: /gpt-6-astra.*未配置/ })[0]).toBeDisabled();
    await user.selectOptions(mail, 'openai/gpt-6.1-sol');
    await user.selectOptions(screen.getByLabelText('日报与推荐'), 'openai/gpt-6.1-sol');
    await user.click(screen.getByRole('button', { name: '保存模型' }));
    await waitFor(() => expect(settings.etag).toBe('2'));
    view.unmount();
    renderApp('/setup');
    expect(await screen.findByLabelText('逐封邮件摘要')).toHaveValue('openai/gpt-6.1-sol');
    expect(screen.getByLabelText('日报与推荐')).toHaveValue('openai/gpt-6.1-sol');
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(1);
  });

  it('saves mail independently from reports through the owner API without computing content', async () => {
    const user = userEvent.setup();
    const { calls } = mockApi({
      'GET /api/v1/integration': setup(),
      'PATCH /api/v1/modelSettings': {
        name: 'modelSettings',
        email_model: 'gpt-6.1-sol',
        report_model: 'gemini-3.8-flash',
        etag: '1',
      },
    });
    renderApp('/setup');
    const mail = await screen.findByLabelText('逐封邮件摘要');
    expect(mail).toHaveValue('gemini-3.5-flash-lite');
    expect(screen.getByLabelText('日报与推荐')).toHaveValue('gemini-3.8-flash');
    await user.selectOptions(mail, 'gpt-6.1-sol');
    await user.click(screen.getByRole('button', { name: '保存模型' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const update = calls.find((call) => call.method === 'PATCH')!;
    expect(update.body).toMatchObject({ email_model: 'gpt-6.1-sol', report_model: 'gemini-3.8-flash' });
    expect(new URLSearchParams(update.search).get('etag')).toBe('0');
    expect(update.headers['x-csrf-token']).toBe('1');
    expect(new URLSearchParams(update.search).get('update_mask')).toBe('email_model,report_model');
    expect(calls.some((call) => call.path.includes('recompute'))).toBe(false);
  });

  it('keeps the selected values visible when the settings revision is rejected', async () => {
    const user = userEvent.setup();
    mockApi({ 'GET /api/v1/integration': setup(), 'PATCH /api/v1/modelSettings': apiError(409, 'ETAG_MISMATCH') });
    renderApp('/setup');
    const mail = await screen.findByLabelText('逐封邮件摘要');
    await user.selectOptions(mail, 'gpt-6.1-sol');
    await user.click(screen.getByRole('button', { name: '保存模型' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ETAG_MISMATCH');
    expect(mail).toHaveValue('gpt-6.1-sol');
  });
});
