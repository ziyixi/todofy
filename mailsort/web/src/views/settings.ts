/**
 * 设置 (`/settings`): the mode (off, shadow, live), the write limits, the daily neuron budget and the thresholds. Every
 * save names its fields in the update mask (the API requires it) with the settings' etag.
 */
import { create } from '@ziyixi/proto/protobuf'
import { Mode, SettingsSchema } from '@ziyixi/proto/mailsort/ui/v1/status_pb'
import { api } from '../api.ts'
import { button, el, fill } from '../dom.ts'
import { MODE_NAMES } from '../format.ts'
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
    const [runBox, run] = number('每次运行最多写入', settings.runWriteLimit, { min: '1', max: '10' })
    const [dayBox, day] = number('每天最多写入（超过即退回影子模式）', settings.dailyWriteLimit, { min: '1', max: '500' })
    const [budgetBox, budget] = number('每天 neuron 预算（超过 70% 改用 Clef-flash）', settings.dailyNeuronBudget, { min: '500', max: '10000', step: '100' })
    const [thresholdBox, threshold] = number('默认阈值', settings.defaultThreshold, { min: '0.5', max: '0.99', step: '0.01' })
    const [targetBox, target] = number('正式标签的精确率下界目标', settings.precisionTarget, { min: '0.5', max: '0.99', step: '0.01' })
    const save = () =>
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
            updateMask: { paths: ['mode', 'run_write_limit', 'daily_write_limit', 'daily_neuron_budget', 'default_threshold', 'precision_target', 'etag'] },
            requestId,
          }),
        '已保存',
        () => reload(),
      )
    fill(
      body,
      el('p', { class: 'hint' }, `当前生效：${MODE_NAMES[settings.effectiveMode] ?? '—'}${settings.breakerTripped ? `（熔断：${settings.breakerReason}，重新选择模式即可解除）` : ''}`),
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
