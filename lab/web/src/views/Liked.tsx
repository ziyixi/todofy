/** 已喜欢 (docs/ux.md §6): newest first, 50 per page, a title search, links, and 取消喜欢 with an undo. */
import { useInfiniteQuery, useMutation } from '@tanstack/react-query'
import { ExternalLink, FileText, Search } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { quoteLiteral } from '@ziyixi/proto/filter'
import type { LikedPaper } from '@ziyixi/proto/lab/ui/v1/library_pb'
import { LIKED_FILTER_MAX } from '../../../worker/src/limits.ts'
import { errorMessage, lab, withRetry } from '../api/client'
import { useFeedback } from '../components/Feedback'
import { formatWhen, newOpId, safeArxivUrl, sentences } from '../lib/format'
import { isoOf } from '../lib/messages'

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
    // The box searches for its text as one phrase: an AIP-160 quoted literal, whatever the owner typed.
    queryFn: ({ pageParam }) => lab.listLikedPapers({ pageToken: pageParam, filter: quoteLiteral(q) }),
    initialPageParam: '',
    getNextPageParam: (last) => (last.nextPageToken === '' ? undefined : last.nextPageToken),
  })
  const papers = liked.data?.pages.flatMap((page) => page.likedPapers) ?? []

  return (
    <section className="panel" aria-labelledby="liked-title">
      <h1 id="liked-title">已喜欢</h1>
      <p className="muted">喜欢的论文会让相似论文排得更靠前。取消喜欢后，明天的排序不再参考它。</p>
      <div className="search">
        <label htmlFor={searchId} className="sr-only">
          按标题搜索
        </label>
        <Search size={18} aria-hidden="true" />
        <input id={searchId} type="search" placeholder="按标题搜索" maxLength={LIKED_FILTER_MAX} value={text} onChange={(event) => setText(event.target.value)} />
      </div>
      {liked.isPending ? <p className="muted">正在加载…</p> : null}
      {liked.isError ? <p role="alert">没有加载出来：{errorMessage(liked.error)}</p> : null}
      {liked.isSuccess && papers.length === 0 ? <p className="muted">{q ? '没有找到标题匹配的论文。' : '还没有喜欢的论文。去今日划一划吧。'}</p> : null}
      <ul className="library">
        {papers.map((paper) => (
          <LikedRow key={paper.name} liked={paper} />
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

/** 取消喜欢 deletes the like (DeleteLikedPaper); 恢复喜欢 creates it again (CreateLikedPaper). */
function LikedRow({ liked }: { liked: LikedPaper }) {
  const { announce, snack } = useFeedback()
  const paper = liked.paper
  const title = paper?.title ?? ''
  const [label, setLabel] = useState<'like' | null>('like')
  const feedback = useMutation({
    mutationFn: async (next: 'like' | null) => {
      const requestId = newOpId()
      if (next === null) await withRetry(() => lab.deleteLikedPaper({ name: liked.name, requestId }))
      else await withRetry(() => lab.createLikedPaper({ likedPaper: {}, likedPaperId: liked.name.slice('likedPapers/'.length), requestId }))
      return next
    },
    onMutate: (next) => setLabel(next),
    onError: (error, next) => {
      setLabel(next === null ? 'like' : null)
      snack({ text: `没有保存：${errorMessage(error)}`, tone: 'warn' })
    },
    onSuccess: (next) => {
      announce(next === 'like' ? `已恢复喜欢：${title}` : `已取消喜欢：${title}`)
    },
  })
  const abs = safeArxivUrl(paper?.abstractUri ?? '')
  const pdf = safeArxivUrl(paper?.pdfUri ?? '')
  const likedAt = isoOf(liked.createTime)
  const firstLine = liked.brief ? liked.brief.split(/(?<=[。！？])/)[0] : sentences(paper?.abstractText ?? '')[0]
  return (
    <li className={`library-row${label === null ? ' is-excluded' : ''}`}>
      <h2 className="library-title" lang="en">
        {title}
      </h2>
      {firstLine ? <p className="liked-brief">{firstLine}</p> : null}
      <p className="muted small">
        {likedAt ? formatWhen(likedAt) : ''} 喜欢{paper?.newVersion ? ' · 有新版本' : ''}
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
          aria-label={`${label === 'like' ? '取消喜欢' : '恢复喜欢'}：${title}`}
          onClick={() => feedback.mutate(label === 'like' ? null : 'like')}
        >
          {label === 'like' ? '取消喜欢' : '恢复喜欢'}
        </button>
      </div>
    </li>
  )
}
