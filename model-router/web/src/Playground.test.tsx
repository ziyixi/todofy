import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { Playground } from './Playground'
import { generation, mockApi, models, record } from './test/fixtures'
import { deferred, renderApp } from './test/harness'

test('uses native provider-labelled models and sends a flat request with cleared options after a model change', async () => {
  const user = userEvent.setup()
  const api = mockApi()
  renderApp(<Playground api={api} models={models} onGenerated={vi.fn()} />)
  expect(screen.getByRole('option', { name: 'Anthropic · claude-opus-5-5' })).toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /BGE/ })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Temperature')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('要求实际网页检索观测')).not.toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('推理强度'), 'high')
  await user.click(screen.getByText('其他选项', { selector: 'summary' }))
  await user.type(screen.getByLabelText('最大输出 token'), '90')
  await user.click(screen.getByLabelText('允许供应商原生回退'))
  await user.selectOptions(screen.getByLabelText('模型'), 'gpt-6.1-sol')
  expect(screen.queryByLabelText('推理强度')).not.toBeInTheDocument()
  expect(screen.getByLabelText('最大输出 token')).toHaveValue(null)
  expect(screen.getByLabelText('允许供应商原生回退')).not.toBeChecked()
  await user.type(screen.getByLabelText('输入'), 'Synthetic input')
  await user.click(screen.getByRole('button', { name: '运行推理' }))
  await waitFor(() => expect(api.generate).toHaveBeenCalledOnce())
  expect(vi.mocked(api.generate).mock.calls[0]?.[0]).toEqual({
    model: 'gpt-6.1-sol',
    input: 'Synthetic input',
    instructions: [],
  })
})

test('renders final text safely and keeps unknown subscription usage and estimates unknown', async () => {
  const user = userEvent.setup()
  const api = mockApi({
    generate: vi.fn().mockResolvedValue({
      ...generation,
      model: 'gpt-6.1-sol',
      output: '<img src=x onerror="alert(1)">',
      usage: { available: false, billing_kind: 'subscription' },
    }),
  })
  renderApp(<Playground api={api} models={models} onGenerated={vi.fn()} />)
  await user.selectOptions(screen.getByLabelText('模型'), 'gpt-6.1-sol')
  await user.type(screen.getByLabelText('输入'), 'A synthetic input')
  await user.click(screen.getByRole('button', { name: '运行推理' }))
  const result = screen.getByRole('region', { name: '推理结果' })
  expect(await within(result).findByText('<img src=x onerror="alert(1)">')).toBeInTheDocument()
  expect(result.querySelector('img')).toBeNull()
  expect(within(result).getByText('服务未提供 token 用量，不能按零用量计算。')).toBeInTheDocument()
  expect(within(result).getByText('API 等价估算未提供')).toBeInTheDocument()
  expect(within(result).queryByText(/US\$0/)).not.toBeInTheDocument()
  expect(within(result).getByText('OpenAI · gpt-6.1-sol')).toBeInTheDocument()
})

test('waits for one final result and keeps the draft on a model failure', async () => {
  const user = userEvent.setup()
  const pending = deferred<typeof generation>()
  const api = mockApi({ generate: vi.fn().mockReturnValue(pending.promise) })
  renderApp(<Playground api={api} models={models} onGenerated={vi.fn()} />)
  await user.type(screen.getByLabelText('输入'), 'Keep this synthetic draft')
  await user.click(screen.getByRole('button', { name: '运行推理' }))
  expect(screen.getByRole('button', { name: '推理中…' })).toBeDisabled()
  pending.resolve({ ...generation, output: '', error: { code: 8, message: 'Synthetic quota exceeded' } })
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

test('copies retained native options and prevents running an unconfigured model', async () => {
  const user = userEvent.setup()
  const api = mockApi()
  renderApp(
    <Playground
      api={api}
      models={models}
      initial={{ request: record.request, sourceRequest: 'synthetic-id' }}
      onGenerated={vi.fn()}
    />,
  )
  expect(screen.getByLabelText('Instructions 1')).toHaveValue('Synthetic instructions')
  expect(screen.getByLabelText('稳定内容，可用于提示缓存')).toBeChecked()
  expect(screen.getByLabelText('输入')).toHaveValue(record.request?.input)
  expect(screen.getByLabelText('推理强度')).toHaveValue('high')
  expect(screen.getByLabelText('最大输出 token')).toHaveValue(100)
  await user.selectOptions(screen.getByLabelText('模型'), 'gemini-3.8-flash')
  expect(screen.getByRole('button', { name: '运行推理' })).toBeDisabled()
  expect(api.generate).not.toHaveBeenCalled()
})

test('labels a known subscription API equivalent as a comparison rather than an API charge', async () => {
  const user = userEvent.setup()
  const api = mockApi({
    generate: vi.fn().mockResolvedValue({
      ...generation,
      usage: {
        available: true,
        input_tokens: 100,
        output_tokens: 20,
        billing_kind: 'subscription',
        estimated_cost_microusd: 250,
      },
    }),
  })
  renderApp(<Playground api={api} models={models} onGenerated={vi.fn()} />)
  expect(screen.queryByLabelText('计费配置')).not.toBeInTheDocument()
  await user.type(screen.getByLabelText('输入'), 'Synthetic equivalent estimate')
  await user.click(screen.getByRole('button', { name: '运行推理' }))
  expect(await screen.findByText('US$0.000250 API 等价（非账单）')).toBeInTheDocument()
})
