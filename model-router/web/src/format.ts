import type { Generation, Model, Usage } from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'

const numberFormat = new Intl.NumberFormat('zh-CN')
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function count(value: number | undefined): string {
  return value === undefined ? '未提供' : numberFormat.format(value)
}

export function time(value: string | undefined): string {
  if (!value) return '未提供'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '时间无效' : timeFormat.format(date)
}

export function duration(value: number | undefined): string {
  if (value === undefined) return '未提供'
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`
}

export function modelName(name: string | undefined): string {
  return name || '未提供'
}

export function requestId(name: string | undefined): string {
  return name?.replace(/^requests\//, '') || '未提供'
}

export function stateLabel(value: string | undefined): string {
  return (
    (
      {
        running: '进行中',
        succeeded: '成功',
        failed: '失败',
        cancelled: '已取消',
        interrupted: '已中断',
      } as Record<string, string>
    )[value ?? ''] ??
    (value || '未知')
  )
}

export function billingLabel(kind: string | undefined): string {
  return (
    ({ api: 'API', subscription: '订阅用量', platform_quota: '平台配额' } as Record<string, string>)[
      kind ?? ''
    ] ?? '计费方式未提供'
  )
}

export function providerLabel(provider: string | undefined): string {
  return (
    (
      { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', cloudflare: 'Cloudflare' } as Record<
        string,
        string
      >
    )[provider ?? ''] ||
    provider ||
    '供应商未提供'
  )
}

export function modelLabel(model: Model): string {
  return `${providerLabel(model.provider)} · ${model.id || model.display_name || '未提供'}`
}

export function money(microusd: number): string {
  return `US$${(microusd / 1_000_000).toFixed(6)}`
}

export function cost(usage: Usage | undefined): string {
  if (usage?.billing_kind === 'platform_quota') return '平台配额'
  const subscription = usage?.billing_kind === 'subscription'
  if (usage?.estimated_cost_microusd === undefined)
    return subscription ? 'API 等价估算未提供' : '费用估算未提供'
  return `${money(usage.estimated_cost_microusd)} ${subscription ? 'API 等价（非账单）' : 'API 估算'}`
}

export function totalTokens(generation: Generation | undefined): string {
  if (!generation?.usage?.available) return '未提供'
  return count((generation.usage.input_tokens ?? 0) + (generation.usage.output_tokens ?? 0))
}

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2)
  } catch {
    return text
  }
}
