/**
 * 偏好 (`/profile`, ../../docs/design.md §10, §11): what the votes taught, one weight per topic of the profile in its
 * order (0.6 to 1.4, 1 before any feedback), each with its 写法 and the votes of the last 8 weeks behind it, when the
 * weekly update last ran, and 重置 (every topic's and source's weight back to 1, earlier votes no longer counted;
 * the votes stay on their items). The profile's own words never change here.
 */
import type { Profile, TopicWeight } from '@ziyixi/proto/brief/ui/v1/status_pb'
import { api } from '../api.ts'
import { card, chip, meter } from '../components.ts'
import { button, el, fill } from '../dom.ts'
import { FORMAT_NAMES, topicName, weight, when } from '../format.ts'
import type { ViewContext } from '../app.ts'
import { act, frame } from './common.ts'

/** The weights' range (design §10). */
const LOW = 0.6
const HIGH = 1.4

function row(topic: TopicWeight): HTMLElement {
  const name = topicName(topic.topic)
  return el(
    'li',
    {},
    el('div', { class: 'row-head' }, el('span', { class: 'row-title' }, name), chip(FORMAT_NAMES[topic.format] ?? '—', 'muted'), el('span', { class: 'meta' }, weight(topic.weight))),
    meter(topic.weight - LOW, HIGH - LOW, `${name}的权重 ${weight(topic.weight)}`),
    el(
      'p',
      { class: 'facts' },
      topic.shownCount === 0
        ? el('span', {}, '近 8 周没有上过')
        : el('span', {}, `上过 ${String(topic.shownCount)} 条 · 👍 ${String(topic.upCount)} · 👎 ${String(topic.downCount)} · 多来点 ${String(topic.moreCount)}`),
    ),
  )
}

export async function renderProfile(ctx: ViewContext): Promise<void> {
  const now = ctx.host.now()
  await frame(ctx.main, '偏好', async (body) => {
    const paint = (profile: Profile) => {
      const reset = () => {
        if (!ctx.host.confirm('把所有主题和来源的权重恢复为 1，并不再计入此前的投票？投票本身仍留在条目上。')) return
        void act((requestId) => api.resetProfile({ name: 'profile', requestId }), '已重置偏好', paint)
      }
      fill(
        body,
        card(
          '主题权重',
          profile.updateTime === undefined ? '尚未更新' : `更新于 ${when(profile.updateTime, now)}`,
          el('p', { class: 'hint' }, '每周日中午按近 8 周的投票更新；高于 1 多选，低于 1 少选。只调整权重，从不改写兴趣描述。'),
          el('ul', { class: 'rows weights' }, ...profile.topics.map(row)),
          el(
            'div',
            { class: 'actions' },
            button('重置', reset, { class: 'danger' }),
            el('span', { class: 'hint' }, profile.resetTime === undefined ? '所有权重回到 1，此前的投票不再计入' : `上次重置 ${when(profile.resetTime, now)}`),
          ),
        ),
      )
    }
    paint(await api.getProfile({ name: 'profile' }))
  })
}
