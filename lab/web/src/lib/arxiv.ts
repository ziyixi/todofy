/**
 * Seed input: one arXiv ID or link per line (docs/ux.md §6). The browser only pre-checks the shape so the
 * owner sees mistakes at once; the Worker validates again and resolves each ID.
 */
const NEW_STYLE = /^(\d{4}\.\d{4,5})(?:v\d+)?$/
const OLD_STYLE = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/

/** A bare ID without version (`2409.01234`, `cs/0112017`), or null when the line is not one. */
export function parseArxivId(line: string): string | null {
  let text = line.trim()
  if (text === '') return null
  text = text.replace(/^arxiv:/i, '')
  // Links: [https://][www.|export.]arxiv.org/(abs|pdf|html)/<id>[.pdf][?…][#…]
  const link = /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?(?:[?#].*)?$/i.exec(text)
  if (link?.[1]) text = link[1]
  const modern = NEW_STYLE.exec(text)
  if (modern?.[1]) return modern[1]
  const old = OLD_STYLE.exec(text)
  return old?.[1] ?? null
}

export interface ParsedSeeds {
  /** Distinct IDs in input order. */
  readonly ids: readonly string[]
  /** Non-empty lines that are not an arXiv ID or link. */
  readonly invalid: readonly string[]
}

export function parseSeedInput(text: string): ParsedSeeds {
  const ids: string[] = []
  const invalid: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const id = parseArxivId(line)
    if (id === null) invalid.push(line.trim())
    else if (!ids.includes(id)) ids.push(id)
  }
  return { ids, invalid }
}
