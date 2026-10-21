#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

/** An anonymous MCP request must reach Access's OAuth challenge, without following a login redirect. */
export async function checkAccessChallenge(host, fetcher = fetch) {
  if (typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host)) throw new Error('PUBLIC_HOST_INVALID')
  const origin = `https://${host}`
  const response = await fetcher(`${origin}/mcp`, {
    redirect: 'manual',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status !== 401) throw new Error('MANAGED_OAUTH_CHALLENGE_MISSING')
  const challenge = response.headers.get('WWW-Authenticate') ?? ''
  if (!/^Bearer\s/i.test(challenge)) throw new Error('MANAGED_OAUTH_CHALLENGE_INVALID')
  const advertised = /\bresource_metadata="([^"]+)"/.exec(challenge)?.[1]
  if (!advertised) throw new Error('MANAGED_OAUTH_METADATA_MISSING')
  const metadata = new URL(advertised)
  if (metadata.origin !== origin || !metadata.pathname.startsWith('/.well-known/')
    || metadata.username || metadata.password || metadata.search || metadata.hash) {
    throw new Error('MANAGED_OAUTH_METADATA_INVALID')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await checkAccessChallenge(process.env.PUBLIC_HOST)
    console.log('Access returned a managed OAuth challenge for /mcp.')
  } catch (error) {
    console.error(error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message : 'MANAGED_OAUTH_PROBE_FAILED')
    process.exitCode = 1
  }
}
