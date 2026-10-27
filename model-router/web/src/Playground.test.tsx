import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { Playground } from './Playground'
import { generation, mockApi, models, record } from './test/fixtures'
import { deferred, renderApp } from './test/harness'

test('switching models clears unsupported parameters and sends only the common contract', async () => {
  const user = userEvent.setup()
  const api = mockApi()
  renderApp(<Playground api={api} models={models} onGenerated={vi.fn()} />)
  await user.selectOptions(screen.getByLabelText('推理强度'), 'high')
  await user.type(screen.getByLabelText('Temperature'), '0.5')
  await user.type(screen.getByLabelText('最大输出 token'), '90')
  await user.selectOptions(screen.getByLabelText('模型'), 'models/subscription')
  expect(screen.getByLabelText('推理强度')).toBeDisabled()
  expect(screen.getByLabelText('Temperature')).toBeDisabled()
  expect(screen.getByLabelText('最大输出 token')).toBeDisabled()
  expect(screen.queryByRole('option', { name: 'Vector' })).not.toBeInTheDocument()
  await user.type(screen.getByLabelText('输入'), 'Synthetic input')
  await user.click(screen.getByRole('button', { name: '运行推理' }))
  await waitFor(() => expect(api.generate).toHaveBeenCalledOnce())
  const sent = vi.mocked(api.generate).mock.calls[0]?.[0]
  expect(sent?.request_id).toMatch(/^[\da-f-]{36}$/)
  expect(sent?.input).toBe('Synthetic input')
  expect(sent?.config).toEqual({ model: 'models/subscription', instructions: [], parameters: {} })
  expect(sent?.metadata).toEqual({ billing_app: 'console' })
  expect(sent).not.toHaveProperty('app')
})

test('renders final text safely and preserves unknown subscription usage', async () => {
  const user = userEvent.setup()
  const api = mockApi({
    generate: vi.fn().mockResolvedValue({
      ...generation,
      output: '<img src=x onerror="alert(1)">',
      reported_model: '',
      usage: { available: false, billing_kind: 'subscription' },
    }),
  })
  renderApp(<Playground api={api} models={models} onGenerated={vi.fn()} />)
  await user.type(screen.getByLabelText('输入'), 'A synthetic input')
  await user.click(screen.getByRole('button', { name: '运行推理' }))
  const result = screen.getByRole('region', { name: '推理结果' })
  expect(await within(result).findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument()
  expect(result.querySelector('img')).toBeNull()
  expect(within(result).getByText('服务未提供 token 用量，不能按零用量计算。')).toBeInTheDocument()
  expect(within(result).getAllByText('订阅用量')).toHaveLength(2)
  expect(within(result).queryByText(/US\$0/)).not.toBeInTheDocument()
  expect(within(result).getByText('服务报告模型').nextElementSibling).toHaveTextContent('未提供')
})

test('waits for one final generation and shows model failure without clearing the input', async () => {
  const user = userEvent.setup()
  const pending = deferred<typeof generation>()
  const api = mockApi({ generate: vi.fn().mockReturnValue(pending.promise) })
  renderApp(<Playground api={api} models={models} onGenerated={vi.fn()} />)
  await user.type(screen.getByLabelText('输入'), 'Keep this synthetic draft')
  await user.click(screen.getByRole('button', { name: '运行推理' }))
  expect(screen.getByRole('button', { name: '推理中…' })).toBeDisabled()
  expect(screen.getByLabelText('输入')).toHaveValue('Keep this synthetic draft')
  pending.resolve({
    ...generation,
    state: 'failed',
    output: '',
    error: { code: 8, message: 'Synthetic quota exceeded' },
  })
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic quota exceeded')
  expect(screen.getByLabelText('输入')).toHaveValue('Keep this synthetic draft')
  expect(api.generate).toHaveBeenCalledOnce()
})

test('validates schema before invoking and supports keyboard submission', async () => {
  const user = userEvent.setup()
  const api = mockApi()
  renderApp(<Playground api={api} models={models} onGenerated={vi.fn()} />)
  await user.type(screen.getByLabelText('输入'), 'Synthetic input')
  await user.click(screen.getByText('JSON Schema', { selector: 'summary' }))
  await user.type(screen.getByLabelText('JSON Schema'), '{{invalid')
  await user.click(screen.getByRole('button', { name: '运行推理' }))
  expect(screen.getByRole('alert')).toHaveTextContent('JSON Schema 格式无效')
  expect(api.generate).not.toHaveBeenCalled()
  await user.clear(screen.getByLabelText('JSON Schema'))
  await user.click(screen.getByLabelText('输入'))
  await user.keyboard('{Control>}{Enter}{/Control}')
  await waitFor(() => expect(api.generate).toHaveBeenCalledOnce())
})

test('copies the full neutral instruction configuration and disallows an unconfigured model', async () => {
  const user = userEvent.setup()
  const api = mockApi()
  renderApp(
    <Playground
      api={api}
      models={models}
      initial={{ config: record.config, input: record.input, sourceRequest: 'synthetic-id' }}
      onGenerated={vi.fn()}
    />,
  )
  expect(screen.getByLabelText('Instructions 1')).toHaveValue('Synthetic instructions')
  expect(screen.getByRole('checkbox', { name: '稳定内容，可用于提示缓存' })).toBeChecked()
  expect(screen.getByLabelText('输入')).toHaveValue(record.input)
  expect(screen.getByLabelText('推理强度')).toHaveValue('high')
  await user.selectOptions(screen.getByLabelText('模型'), 'models/unconfigured')
  expect(screen.getByRole('button', { name: '运行推理' })).toBeDisabled()
  expect(api.generate).not.toHaveBeenCalled()
})

test('paid connections require an explicit billing profile selection', async () => {
  const user = userEvent.setup()
  const listModels = vi
    .fn()
    .mockResolvedValue([{ ...models[0], name: 'models/paid', display_name: 'Paid profile model', configured: true }])
  const api = mockApi({ listModels })
  renderApp(<Playground api={api} models={models} onGenerated={vi.fn()} />)
  expect(screen.getByLabelText('计费配置')).toHaveValue('console')
  expect(listModels).not.toHaveBeenCalled()
  await user.selectOptions(screen.getByLabelText('计费配置'), 'brief')
  await waitFor(() => expect(listModels).toHaveBeenCalledWith('brief'))
  expect(await screen.findByRole('option', { name: 'Paid profile model' })).toBeInTheDocument()
  await user.type(screen.getByLabelText('输入'), 'Synthetic paid-profile input')
  await user.click(screen.getByRole('button', { name: '运行推理' }))
  await waitFor(() => expect(api.generate).toHaveBeenCalledOnce())
  const sent = vi.mocked(api.generate).mock.calls[0]?.[0]
  expect(sent?.metadata).toEqual({ billing_app: 'brief' })
  expect(sent?.config?.model).toBe('models/paid')
  expect(sent).not.toHaveProperty('app')
})
