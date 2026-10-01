/**
 * The card's content (docs/ux.md §3 anatomy): meta row, title, authors, the 简介 as the visual centre,
 * "为什么推荐", the expandable original abstract and the arXiv / PDF links. Everything from arXiv and the
 * model is rendered as React text, never HTML.
 */
import { ExternalLink, FileText } from 'lucide-react'
import { useId } from 'react'
import { DeckKind, type Card } from '@ziyixi/proto/lab/ui/v1/deck_pb'
import { AnnounceType } from '@ziyixi/proto/lab/ui/v1/paper_pb'
import { cardBrief, formatAuthors, safeArxivUrl } from '../lib/format'
import { paperOf } from '../lib/messages'

interface PaperCardBodyProps {
  readonly card: Card
  readonly kind: DeckKind
  readonly expanded: boolean
  readonly onToggle?: () => void
  /** The id of the title element (the card's accessible name and the focus target). */
  readonly titleId: string
  /** False for the peeking cards and the leaving copy: their controls are inert. */
  readonly interactive: boolean
}

export function PaperCardBody({ card, kind, expanded, onToggle, titleId, interactive }: PaperCardBodyProps) {
  const abstractId = useId()
  const brief = cardBrief(card)
  const paper = paperOf(card)
  const abs = safeArxivUrl(paper.abstractUri)
  const pdf = safeArxivUrl(paper.pdfUri)
  const tab = interactive ? undefined : -1
  return (
    <div className="card-scroll">
      <div className="card-meta">
        <span className="card-rank">#{card.position}</span>
        <span className="chip" lang="en">
          {paper.primaryCategory}
        </span>
        {paper.announceType === AnnounceType.CROSS ? <span className="chip chip-muted">交叉</span> : null}
        {kind === DeckKind.EXPLORE ? <span className="chip chip-explore">探索</span> : null}
      </div>
      <h2 className="card-title" id={titleId} tabIndex={-1} lang="en">
        {paper.title}
      </h2>
      <p className="card-authors" lang="en" title={paper.authors}>
        {formatAuthors(paper.authors)}
      </p>
      <section className="card-brief" aria-label={brief.generated ? '简介' : '原文摘要节选'}>
        <p lang={brief.generated ? 'zh-CN' : 'en'}>{brief.text}</p>
        <p className="card-brief-label">{brief.generated ? 'AI 根据摘要生成' : '原文摘要节选'}</p>
      </section>
      {card.because && kind !== DeckKind.EXPLORE ? (
        <p className="card-because">
          为什么推荐：与你喜欢的《<span lang="en">{card.because.title}</span>》相近
        </p>
      ) : null}
      <button
        type="button"
        className="card-disclosure"
        aria-expanded={expanded}
        aria-controls={abstractId}
        onClick={onToggle}
        tabIndex={tab}
      >
        {expanded ? '收起原文摘要' : '展开原文摘要'}
      </button>
      <p className="card-abstract" id={abstractId} lang="en" hidden={!expanded}>
        {paper.abstractText}
      </p>
      <div className="card-links">
        {abs ? (
          <a className="btn btn-quiet" href={abs} target="_blank" rel="noopener noreferrer" tabIndex={tab}>
            <ExternalLink size={16} aria-hidden="true" /> arXiv
          </a>
        ) : null}
        {pdf ? (
          <a className="btn btn-quiet" href={pdf} target="_blank" rel="noopener noreferrer" tabIndex={tab}>
            <FileText size={16} aria-hidden="true" /> PDF
          </a>
        ) : null}
      </div>
    </div>
  )
}
