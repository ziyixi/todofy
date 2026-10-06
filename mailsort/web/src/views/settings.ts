/**
 * 设置 (`/settings`): the mode (off, shadow, live), the write limits, the daily neuron budget and the thresholds. A
 * save names only the fields that changed in the update mask (the API requires a mask), with the settings' etag; a
 * tripped breaker is cleared only by 解除熔断 or by choosing another mode.
 */
import { create } from '@ziyixi/proto/protobuf'
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
import { api } from '../api.ts'
import { button, el, fill, toast } from '../dom.ts'
import { BREAKER_REASONS, MODE_NAMES } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, frame } from './common.ts'

function number(label: string, value: number, attributes: Readonly<Record<string, string>>): [HTMLLabelElement, HTMLInputElement] {
  const input = el('input', { type: 'number', value: String(value), ...attributes })
  return [el('label', { class: 'field' }, el('span', { class: 'label' }, label), input), input]
}

export async function renderSettings(ctx: ViewContext): Promise<void> {
  const reload: () => Promise<void> = await frame(ctx.main, '设置', async (body) => {
    const settings = await api.getSettings({ name: 'settings' })
    const mode = el('select', { 'aria-label': '模式' }, ...[Mode.OFF, Mode.SHADOW, Mode.LIVE].map((value) => el('option', { value: String(value), ...(value === settings.mode ? { selected: true } : {}) }, MODE_NAMES[value] ?? '')))
    const [runBox, run] = number('每次运行最多写入（含重试；超过即退回影子模式）', settings.runWriteLimit, { min: '1', max: '10' })
    const [dayBox, day] = number('每天最多写入（超过即退回影子模式）', settings.dailyWriteLimit, { min: '1', max: '500' })
    const [budgetBox, budget] = number('每天 neuron 预算（超过 70% 改用 Clef-flash）', settings.dailyNeuronBudget, { min: '500', max: '10000', step: '100' })
    const [thresholdBox, threshold] = number('默认阈值', settings.defaultThreshold, { min: '0.5', max: '0.99', step: '0.01' })
    const [targetBox, target] = number('正式标签的精确率下界目标', settings.precisionTarget, { min: '0.5', max: '0.99', step: '0.01' })
    // Only the fields the owner changed go into the mask: naming `mode` is the owner choosing a mode again, which
    // also clears a tripped breaker, so a save of a budget or a threshold must never send it.
    const save = () => {
      const changed: [string, boolean][] = [
        ['mode', Number(mode.value) !== settings.mode],
        ['run_write_limit', Number(run.value) !== settings.runWriteLimit],
        ['daily_write_limit', Number(day.value) !== settings.dailyWriteLimit],
        ['daily_neuron_budget', Number(budget.value) !== settings.dailyNeuronBudget],
        ['default_threshold', Number(threshold.value) !== settings.defaultThreshold],
        ['precision_target', Number(target.value) !== settings.precisionTarget],
      ]
      const paths = changed.filter(([, differs]) => differs).map(([path]) => path)
      if (paths.length === 0) {
        toast('没有改动')
        return
      }
      void act(
        (requestId) =>
          api.updateSettings({
            settings: create(SettingsSchema, {
              name: 'settings',
              mode: Number(mode.value) as Mode,
              runWriteLimit: Number(run.value),
              dailyWriteLimit: Number(day.value),
              dailyNeuronBudget: Number(budget.value),
              defaultThreshold: Number(threshold.value),
              precisionTarget: Number(target.value),
              etag: settings.etag,
            }),
            updateMask: { paths: [...paths, 'etag'] },
            requestId,
          }),
        '已保存',
        () => reload(),
      )
    }
    const resetBreaker = () => {
      if (!ctx.host.confirm(`解除熔断，恢复“${MODE_NAMES[settings.mode] ?? ''}”？请先在操作记录里核对最近的写入。`)) return
      void act(
        (requestId) => api.updateSettings({ settings: create(SettingsSchema, { name: 'settings', mode: settings.mode, etag: settings.etag }), updateMask: { paths: ['mode', 'etag'] }, requestId }),
        '已解除熔断',
        () => reload(),
      )
    }
    const breaker = settings.breakerTripped ? `（熔断：${BREAKER_REASONS[settings.breakerReason] ?? settings.breakerReason}，已退回影子模式）` : ''
    fill(
      body,
      el('p', { class: settings.breakerTripped ? 'hint warn' : 'hint' }, `当前生效：${MODE_NAMES[settings.effectiveMode] ?? '—'}${breaker}`),
      settings.breakerTripped ? el('div', { class: 'actions' }, button('解除熔断', resetBreaker)) : null,
      el('label', { class: 'field' }, el('span', { class: 'label' }, '模式'), mode),
      runBox,
      dayBox,
      budgetBox,
      thresholdBox,
      targetBox,
      el('p', { class: 'hint' }, '紧急关闭：这里选“关闭”，或设置 GitHub 变量 MAILSORT_MODE；也可在 Google 账号的第三方访问里撤销授权。'),
      el('div', { class: 'actions' }, button('保存', save, { class: 'primary' })),
    )
  })
}
