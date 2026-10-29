// Build-time input only. The UI never imports another app or a configuration tool.
import { readFileSync } from 'node:fs'
import { parseToml } from '../../tools/cf-guard/toml.mjs'

/** The public pages the UI links to, by their wrangler.toml var. */
export const NAVIGATION = ['HOME_URL', 'FLEET_URL', 'MODEL_ROUTER_URL']

export function validateNavigationURL(name, value) {
  if (typeof value !== 'string') throw new Error(`Newsletter console ${name} is required`)
  let url
  try { url = new URL(value) } catch { throw new Error(`Newsletter console ${name} must be an HTTPS origin`) }
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
      || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Newsletter console ${name} must be an HTTPS origin`)
  }
  return url.href
}

export const validateHomeURL = (value) => validateNavigationURL('HOME_URL', value)

/** {HOME_URL, FLEET_URL, MODEL_ROUTER_URL}, each a validated HTTPS origin. */
export function navigationFromConfig(path = new URL('../wrangler.toml', import.meta.url)) {
  const vars = parseToml(readFileSync(path, 'utf8')).vars ?? {}
  return Object.fromEntries(NAVIGATION.map((name) => [name, validateNavigationURL(name, vars[name])]))
}

export function homeURLFromConfig(path = new URL('../wrangler.toml', import.meta.url)) {
  return navigationFromConfig(path).HOME_URL
}
