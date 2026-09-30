/** 已喜欢 (docs/ux.md §6): newest first, 50 per page, a title search, links, and 取消喜欢 with an undo. */
import { useInfiniteQuery, useMutation } from '@tanstack/react-query'
import { ExternalLink, FileText, Search } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { LikedPaper } from '../../../worker/src/api-types.ts'
import { api, errorMessage, withRetry } from '../api/client'
import { useFeedback } from '../components/Feedback'
import { formatWhen, newOpId, safeArxivUrl, sentences } from '../lib/format'

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return debounced
}

export function LikedView() {
  const searchId = useId()
  const [text, setText] = useState('')
  const q = useDebounced(text.trim(), 300)
  const liked = useInfiniteQuery({
    queryKey: ['liked', q],
    queryFn: ({ pageParam }) => api.liked({ cursor: pageParam, q }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  })
  const papers = liked.data?.pages.flatMap((page) => page.papers) ?? []

  return (
    <section className="panel" aria-labelledby="liked-title">
      <h1 id="liked-title">已喜欢</h1>
      <p className="muted">喜欢的论文会让相似论文排得更靠前。取消喜欢后，明天的排序不再参考它。</p>
      <div className="search">
        <label htmlFor={searchId} className="sr-only">
          按标题搜索
        </label>
        <Search size={18} aria-hidden="true" />
        <input id={searchId} type="search" placeholder="按标题搜索" value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      {liked.isPending ? <p className="muted">正在加载…</p> : null}
      {liked.isError ? <p role="alert">没有加载出来：{errorMessage(liked.error)}</p> : null}
      {liked.isSuccess && papers.length === 0 ? <p className="muted">{q ? '没有找到标题匹配的论文。' : '还没有喜欢的论文。去今日划一划吧。'}</p> : null}
      <ul className="library">
        {papers.map((paper) => (
          <LikedRow key={paper.id} paper={paper} />
        ))}
      </ul>
      {liked.hasNextPage ? (
        <button type="button" className="btn btn-quiet" disabled={liked.isFetchingNextPage} onClick={() => void liked.fetchNextPage()}>
          {liked.isFetchingNextPage ? '正在加载…' : '加载更多'}
        </button>
      ) : null}
    </section>
  )
}

function LikedRow({ paper }: { paper: LikedPaper }) {
  const { announce, snack } = useFeedback()
  const [label, setLabel] = useState<'like' | null>('like')
  const feedback = useMutation({
    mutationFn: (next: 'like' | null) => {
      const body = { op_id: newOpId(), paper_id: paper.id, label: next }
      return withRetry(() => api.feedback(body))
    },
    onMutate: (next) => setLabel(next),
    onError: (error, next) => {
      setLabel(next === null ? 'like' : null)
      snack({ text: `没有保存：${errorMessage(error)}`, tone: 'warn' })
    },
    onSuccess: (response) => {
      announce(response.label === 'like' ? `已恢复喜欢：${paper.title}` : `已取消喜欢：${paper.title}`)
    },
  })
  const abs = safeArxivUrl(paper.abs_url)
  const pdf = safeArxivUrl(paper.pdf_url)
  const firstLine = paper.brief ? paper.brief.split(/(?<=[。！？])/)[0] : sentences(paper.abstract)[0]
  return (
    <li className={`library-row${label === null ? ' is-excluded' : ''}`}>
      <h2 className="library-title" lang="en">
        {paper.title}
      </h2>
      {firstLine ? <p className="liked-brief">{firstLine}</p> : null}
      <p className="muted small">
        {formatWhen(paper.liked_at)} 喜欢{paper.new_version ? ' · 有新版本' : ''}
      </p>
      <div className="button-row">
        {abs ? (
          <a className="btn btn-quiet btn-small" href={abs} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={16} aria-hidden="true" /> arXiv
          </a>
        ) : null}
        {pdf ? (
          <a className="btn btn-quiet btn-small" href={pdf} target="_blank" rel="noopener noreferrer">
            <FileText size={16} aria-hidden="true" /> PDF
          </a>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-small"
          disabled={feedback.isPending}
          aria-label={`${label === 'like' ? '取消喜欢' : '恢复喜欢'}：${paper.title}`}
          onClick={() => feedback.mutate(label === 'like' ? null : 'like')}
        >
          {label === 'like' ? '取消喜欢' : '恢复喜欢'}
        </button>
      </div>
    </li>
  )
}
