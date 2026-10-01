/**
 * 种子 (docs/ux.md §6): the cold-start entry. Paste arXiv IDs or links, one per line (≤ 50 seeds in all);
 * each seed shows its state (解析中 / 已添加 / 未找到).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import type { ListSeedsResponse } from '@ziyixi/proto/lab/ui/v1/lab_ui_service_pb'
import { Seed_State } from '@ziyixi/proto/lab/ui/v1/library_pb'
import { SEEDS_MAX } from '../../../worker/src/limits.ts'
import { errorMessage, lab, withRetry } from '../api/client'
import { useFeedback } from '../components/Feedback'
import { parseSeedInput } from '../lib/arxiv'
import { newOpId } from '../lib/format'

/** Seeds + likes from which the ranking counts as personalised (docs/ux.md §1, Semantic Scholar's advice). */
export const PERSONALISED_AT = 3

const SEED_STATE: Readonly<Record<Seed_State, string>> = {
  [Seed_State.UNSPECIFIED]: '',
  [Seed_State.PENDING]: '解析中',
  [Seed_State.RESOLVED]: '已添加',
  [Seed_State.NOT_FOUND]: '未找到',
}

export function SeedsView() {
  const client = useQueryClient()
  const { announce, snack } = useFeedback()
  const inputId = useId()
  const hintId = useId()
  const [text, setText] = useState('')
  const seeds = useQuery({ queryKey: ['seeds'], queryFn: () => lab.listSeeds({}) })
  const parsed = parseSeedInput(text)
  const list = seeds.data?.seeds ?? []
  const room = SEEDS_MAX - list.length
  const fresh = parsed.ids.filter((id) => !list.some((seed) => seed.paperId === `arxiv:${id}` || seed.paperId === id))

  const add = useMutation({
    mutationFn: (ids: readonly string[]) => {
      const request = { requestId: newOpId(), inputs: [...ids] }
      return withRetry(() => lab.importSeeds(request))
    },
    onSuccess: (next, ids) => {
      client.setQueryData<ListSeedsResponse | undefined>(['seeds'], (current) => (current ? { ...current, seeds: next.seeds } : current))
      void client.invalidateQueries({ queryKey: ['seeds'] })
      void client.invalidateQueries({ queryKey: ['today'] })
      setText('')
      announce(`已提交 ${ids.length} 篇种子，正在解析`)
    },
    onError: (error) => snack({ text: `没有添加：${errorMessage(error)}`, tone: 'warn' }),
  })

  const remove = useMutation({
    mutationFn: async (name: string) => {
      const request = { name, requestId: newOpId() }
      await withRetry(() => lab.deleteSeed(request))
      return name
    },
    onSuccess: (name) => {
      client.setQueryData<ListSeedsResponse | undefined>(['seeds'], (current) => (current ? { ...current, seeds: current.seeds.filter((seed) => seed.name !== name) } : current))
      announce('已移除种子')
    },
    onError: (error) => snack({ text: `没有移除：${errorMessage(error)}`, tone: 'warn' }),
  })

  const resolved = list.filter((seed) => seed.state === Seed_State.RESOLVED).length
  const counter =
    resolved >= PERSONALISED_AT ? `有 ${resolved} 篇种子，推荐已个性化` : `有 ${resolved} 篇种子，再添加 ${PERSONALISED_AT - resolved} 篇效果更好`
  const tooMany = fresh.length > room

  return (
    <section className="panel" aria-labelledby="seeds-title">
      <h1 id="seeds-title">种子论文</h1>
      <p>种子是你已经知道自己喜欢的论文。推荐会从它们和你右滑喜欢的论文出发。</p>
      {seeds.data ? (
        <p className="counter" data-testid="seed-counter">
          {counter}
        </p>
      ) : null}
      <form
        className="seed-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (fresh.length > 0 && !tooMany) add.mutate(fresh)
        }}
      >
        <label htmlFor={inputId}>粘贴 arXiv ID 或链接，每行一个</label>
        <textarea
          id={inputId}
          rows={5}
          value={text}
          aria-describedby={hintId}
          placeholder={'2409.01234\narxiv.org/abs/2310.06825'}
          onChange={(event) => setText(event.target.value)}
        />
        <p id={hintId} className="muted small">
          {parsed.ids.length > 0 ? `识别到 ${parsed.ids.length} 篇` : '支持 2409.01234、arXiv:2409.01234 或 arxiv.org 的 abs / pdf 链接'}
          {parsed.invalid.length > 0 ? ` · ${parsed.invalid.length} 行无法识别：${parsed.invalid.slice(0, 3).join('、')}` : ''}
          {tooMany ? ` · 最多 ${SEEDS_MAX} 篇，还能添加 ${Math.max(room, 0)} 篇` : ''}
        </p>
        <button type="submit" className="btn btn-primary" disabled={fresh.length === 0 || tooMany || add.isPending}>
          {add.isPending ? '正在添加…' : fresh.length > 0 ? `添加 ${fresh.length} 篇` : '添加'}
        </button>
      </form>

      {seeds.isPending ? <p className="muted">正在加载…</p> : null}
      {seeds.isError ? <p role="alert">没有加载出来：{errorMessage(seeds.error)}</p> : null}
      {list.length > 0 ? (
        <ul className="library" aria-label="种子">
          {list.map((seed) => (
            <li key={seed.name} className="library-row seed-row">
              <div>
                <p className="library-title" lang="en">
                  {seed.title ?? seed.paperId.replace(/^arxiv:/, '')}
                </p>
                <span className={`badge badge-${seed.state === Seed_State.RESOLVED ? 'ok' : seed.state === Seed_State.NOT_FOUND ? 'warn' : 'info'}`}>
                  {SEED_STATE[seed.state]}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-small"
                disabled={remove.isPending}
                aria-label={`移除种子：${seed.title ?? seed.paperId}`}
                onClick={() => remove.mutate(seed.name)}
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
