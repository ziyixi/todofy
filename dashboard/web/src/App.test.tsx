import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { analyticsUnavailable, healthy, oneWarning } from './test/fixtures'
import { apiError, freezeClock, installFetch, json, renderApp, serve } from './test/harness'

const views = (paths: string[]) => paths.filter((path) => !path.startsWith('/api/v2/registry'))

describe('page shell', () => {
  it('starts on 首页 with four tabs, the registry and only the visible view', async () => {
    freezeClock()
    const calls = serve(healthy())
    renderApp()
    await screen.findByRole('link', { name: /打开 Mail Hero/ })

    const nav = screen.getByRole('navigation', { name: '视图' })
    const tabs = within(nav).getAllByRole('link')
    expect(tabs.map((tab) => tab.getAttribute('href'))).toEqual(['#/', '#/flows', '#/cloudflare', '#/ops'])
    expect(tabs.map((tab) => tab.querySelector('.visually-hidden')?.textContent)).toEqual(['首页', '业务流程', 'Cloudflare 监控', '操作与记录'])
    expect(within(nav).getByRole('link', { name: '首页' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: '业务流程' })).not.toHaveAttribute('aria-current')

    expect(calls.map((call) => call.path).sort()).toEqual(['/api/v2/home', '/api/v2/registry'])
    for (const call of calls) expect(call.init).toMatchObject({ credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
    expect(document.title).toBe('个人控制台')
    expect(screen.getByText('时区：浏览器本地（Asia/Shanghai）')).toBeInTheDocument()
    expect(screen.getByText('构建 0123456')).toBeInTheDocument()
    expect(screen.getByText('用量为整个 Cloudflare 账户')).toBeInTheDocument()
  })

  it('switches views by hash, reads each view once and never re-reads the registry', async () => {
    freezeClock()
    const calls = serve(healthy())
    renderApp()
    const user = userEvent.setup()
    await screen.findByRole('link', { name: /打开 Mail Hero/ })

    await user.click(screen.getByRole('link', { name: '业务流程' }))
    expect(await screen.findByRole('heading', { level: 1, name: '业务流程' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '业务流程' })).toHaveAttribute('aria-current', 'page')
    expect(document.title).toBe('业务流程 · 个人控制台')
    // A tab change moves focus to the new view for keyboard and screen-reader users.
    expect(document.getElementById('main')).toHaveFocus()

    await user.click(screen.getByRole('link', { name: 'Cloudflare 监控' }))
    expect(await screen.findByRole('heading', { name: '账户额度' })).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: '操作与记录' }))
    expect(await screen.findByRole('region', { name: '降载与操作' })).toBeInTheDocument()

    expect(calls.filter((call) => call.path === '/api/v2/registry')).toHaveLength(1)
    expect(views(calls.map((call) => call.path))).toEqual(['/api/v2/home', '/api/v2/flows', '/api/v2/cloudflare', '/api/v2/ops'])
  })

  it('maps the v1 section anchors to their views', async () => {
    freezeClock()
    serve(healthy())
    renderApp('#quota')
    expect(await screen.findByRole('heading', { name: '账户额度' })).toBeInTheDocument()
    await waitFor(() => expect(window.location.hash).toBe('#/cloudflare'))

    renderApp('#canary')
    expect(await screen.findByRole('article', { name: '邮件 → 任务' })).toBeInTheDocument()
  })

  it('counts attention items on the tab that explains them', async () => {
    freezeClock()
    serve(oneWarning())
    renderApp()
    const nav = await screen.findByRole('navigation', { name: '视图' })
    await waitFor(() => expect(within(nav).getByRole('link', { name: '业务流程，1 项需关注' })).toBeInTheDocument())
    expect(within(nav).getByRole('link', { name: '首页' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Cloudflare 监控' })).toBeInTheDocument()
  })

  it('shows the attention strip on every view, the same items', async () => {
    freezeClock()
    serve(analyticsUnavailable())
    renderApp('#/ops')
    const strip = await screen.findByRole('region', { name: '1 项需关注' })
    expect(within(strip).getByRole('link', { name: '查看：个人控制台：用量数据获取失败' })).toHaveAttribute('href', '#/cloudflare')
  })

  it('reports a registry failure and retries on request', async () => {
    freezeClock()
    let fail = true
    const scenario = healthy()
    const calls = installFetch((call) => {
      if (call.path === '/api/v2/registry') {
        return fail ? apiError(503, 'unavailable', '服务暂时不可用', 'aaaaaaaaaaaaaaaa') : json(scenario.registry)
      }
      return json(scenario.home)
    })
    renderApp()
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载页面配置：服务暂时不可用（请求 aaaaaaaaaaaaaaaa）')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByRole('link', { name: /打开 Mail Hero/ })
    expect(calls.filter((call) => call.path === '/api/v2/registry')).toHaveLength(2)
  })

  it('reports a view failure without hiding the other views', async () => {
    freezeClock()
    const scenario = healthy()
    let fail = true
    serve(scenario, () => apiError(404, 'not_found'))
    installFetch((call) => {
      if (call.path === '/api/v2/registry') return json(scenario.registry)
      if (call.path === '/api/v2/flows') return fail ? apiError(503, 'unavailable', '服务暂时不可用', 'bbbbbbbbbbbbbbbb') : json(scenario.flows)
      return json(scenario.home)
    })
    renderApp('#/flows')
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载业务流程数据：服务暂时不可用（请求 bbbbbbbbbbbbbbbb）')
    fail = false
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('article', { name: '邮件 → 任务' })).toBeInTheDocument()
  })

  it('keeps the skip link off the router: it focuses main without changing the hash', async () => {
    freezeClock()
    serve(healthy())
    renderApp('#/cloudflare')
    await screen.findByRole('heading', { name: '账户额度' })
    await userEvent.click(screen.getByRole('link', { name: '跳到主要内容' }))
    expect(document.getElementById('main')).toHaveFocus()
    expect(window.location.hash).toBe('#/cloudflare')
  })

  it('follows hashchange events from outside (digest links, back button)', async () => {
    freezeClock()
    serve(healthy())
    renderApp()
    await screen.findByRole('link', { name: /打开 Mail Hero/ })
    act(() => {
      window.history.pushState(null, '', '#/flows/site-publish')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    const card = await screen.findByRole('article', { name: '网站发布' })
    expect(within(card).getByRole('button', { name: '收起 网站发布' })).toHaveAttribute('aria-expanded', 'true')
  })
})
