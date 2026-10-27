import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { setup } from '../test/fixtures'
import { apiError, mockApi, renderApp } from '../test/harness'

describe('model settings', () => {
  it('saves mail independently from reports through the owner API without computing content', async () => {
    const user = userEvent.setup()
    const { calls } = mockApi({
      'GET /api/v1/integration': setup(),
      'PATCH /api/v1/modelSettings': { name: 'modelSettings', email_model: 'models/sol-6-1', report_model: 'models/gemini-report', etag: '1' },
    })
    renderApp('/setup')
    const mail = await screen.findByLabelText('逐封邮件摘要')
    expect(mail).toHaveValue('models/gemini-email')
    expect(screen.getByLabelText('日报与推荐')).toHaveValue('models/gemini-report')
    await user.selectOptions(mail, 'models/sol-6-1')
    await user.click(screen.getByRole('button', { name: '保存模型' }))
    await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true))
    const update = calls.find(call => call.method === 'PATCH')!
    expect(update.body).toMatchObject({ email_model: 'models/sol-6-1', report_model: 'models/gemini-report' })
    expect(new URLSearchParams(update.search).get('etag')).toBe('0')
    expect(update.headers['x-csrf-token']).toBe('csrf-token-1')
    expect(new URLSearchParams(update.search).get('update_mask')).toBe('email_model,report_model')
    expect(calls.some(call => call.path.includes('recompute'))).toBe(false)
  })

  it('keeps the selected values visible when the settings revision is rejected', async () => {
    const user = userEvent.setup()
    mockApi({ 'GET /api/v1/integration': setup(), 'PATCH /api/v1/modelSettings': apiError(409, 'ETAG_MISMATCH') })
    renderApp('/setup')
    const mail = await screen.findByLabelText('逐封邮件摘要')
    await user.selectOptions(mail, 'models/sol-6-1')
    await user.click(screen.getByRole('button', { name: '保存模型' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('ETAG_MISMATCH')
    expect(mail).toHaveValue('models/sol-6-1')
  })
})
