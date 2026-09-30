/** Only absolute https URLs become links; anything else (a misconfigured var, javascript:) is shown as text. */
export function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
