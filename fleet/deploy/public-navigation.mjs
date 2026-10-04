// Build-time input only. The UI never imports another app or a configuration tool.
import { readFileSync } from 'node:fs'
import { parseToml } from '../../tools/cf-guard/toml.mjs'

export function validateHomeURL(value) {
  if (typeof value !== 'string') throw new Error('Fleet HOME_URL is required')
  let url
  try { url = new URL(value) } catch { throw new Error('Fleet HOME_URL must be an HTTPS origin') }
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
      || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Fleet HOME_URL must be an HTTPS origin')
  }
  return url.href
}

export function homeURLFromConfig(path = new URL('../wrangler.toml', import.meta.url)) {
  return validateHomeURL(parseToml(readFileSync(path, 'utf8')).vars?.HOME_URL)
}
