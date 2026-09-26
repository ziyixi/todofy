import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import { ArrowRight, ChevronLeft, ChevronRight, ClipboardList, RefreshCw } from 'lucide-react'
import { api } from '../api/client'
import { Button, Card, Empty, ErrorState, formatDate, Loading, PageHead, Status } from '../components/UI'

export default function DeliveriesPage() {
  const [params, setParams] = useSearchParams()
  const [history, setHistory] = useState<string[]>([])
  const state = params.get('status') || ''
  const cursor = params.get('cursor') || ''
  const query = useQuery({ queryKey: ['deliveries', state, cursor], queryFn: () => api.deliveries({ status: state, cursor, limit: 50 }) })
  const items = query.data?.items || []
  function filter(next: string) { const search = new URLSearchParams(); if (next) search.set('status', next); setHistory([]); setParams(search) }
  function next() { if (!query.data?.next_cursor) return; setHistory([...history, cursor]); setParams({ ...(state ? { status: state } : {}), cursor: query.data.next_cursor }) }
  function previous() { const copy = [...history]; const old = copy.pop() || ''; setHistory(copy); setParams({ ...(state ? { status: state } : {}), ...(old ? { cursor: old } : {}) }) }

  return <><PageHead eyebrow="DELIVERY · WEBHOOK" title="投递记录" description="每次交付都有独立事件 ID、冻结请求内容和完整尝试历史。" action={<Button variant="secondary" onClick={() => query.refetch()}><RefreshCw size={16}/> 刷新</Button>}/>
    <Card className="delivery-card"><div className="list-caption"><div><h2>事件列表</h2><span>已交付只表示目标服务持久接管</span></div><select aria-label="筛选投递状态" value={state} onChange={event => filter(event.target.value)}><option value="">全部状态</option><option value="pending">等待交付</option><option value="retry_wait">等待重试</option><option value="failed">已停止</option><option value="delivered">已交付</option><option value="cancelled">已取消</option></select></div>
    {query.isPending ? <Loading label="正在读取投递记录…"/> : query.isError ? <ErrorState error={query.error} retry={() => query.refetch()}/> : items.length === 0 ? <Empty icon={<ClipboardList size={25}/>} title="没有投递记录" detail={state ? '此状态下没有事件。' : '邮件被发送到 webhook 目标后，这里会显示每次尝试。'} action={state ? <Button variant="secondary" onClick={() => filter('')}>显示全部</Button> : <Link className="button button-secondary" to="/inbox">查看收件箱</Link>}/> : <div className="table-wrap"><table className="data-table"><thead><tr><th>事件</th><th>目标</th><th>状态</th><th>尝试</th><th>创建时间</th><th aria-label="查看"/></tr></thead><tbody>{items.map(item => <tr key={item.event_id}><td><Link className="table-primary" to={`/deliveries/${encodeURIComponent(item.event_id)}`}>{item.event_id.slice(0, 8)}…</Link><small>{item.replay_of_event_id ? '新事件重发' : '原始事件'}</small></td><td>{item.endpoint_label || item.endpoint_id || '—'}</td><td><Status state={item.effective_state || item.state}/>{item.last_error && <small className="error-text">{item.last_error}</small>}</td><td>{item.attempt_count} 次</td><td>{formatDate(item.created_at)}</td><td><Link className="table-arrow" to={`/deliveries/${encodeURIComponent(item.event_id)}`} aria-label={`查看事件 ${item.event_id}`}><ArrowRight size={17}/></Link></td></tr>)}</tbody></table></div>}
    {(history.length > 0 || query.data?.next_cursor) && <div className="pagination"><Button variant="quiet" disabled={!history.length} onClick={previous}><ChevronLeft size={16}/> 上一页</Button><span>每页最多 50 条</span><Button variant="quiet" disabled={!query.data?.next_cursor} onClick={next}>下一页 <ChevronRight size={16}/></Button></div>}
    </Card>
  </>
}
