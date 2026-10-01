// @vitest-environment node
// The newsletter reports' text rules as an ECMAScript validator (ajv, this UI's tooling) reads them, against the
// hand-written schemas they replaced (tests/unit/legacy/, frozen). JSON Schema specifies ECMA-262 regular
// expressions, so this is the published meaning of todofy/api/*-v1.schema.json; tests/unit/test_report_schema_legacy.py
// compares the same rules in Python's dialect, which the newsletter's str.strip() follows.
//
// The two schemas differ on exactly two characters, by design (proto/todofy/report/v1/report.proto, header): the
// hand-written "\S" read as ECMAScript took U+0085 for a visible character and U+FEFF for whitespace, the reverse
// of the newsletter. A text made only of U+0085 was valid and is refused now; one made only of U+FEFF was refused
// and is valid now. Any other difference is drift and fails here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const API = join(__dirname, '../../../api')
const LEGACY = join(__dirname, '../../../tests/unit/legacy')

interface TextRule {
  readonly pattern: string
  readonly allOf?: readonly { readonly pattern: string }[]
}

interface Branch {
  readonly properties: {
    readonly status: { readonly const: string }
    readonly summary?: TextRule
    readonly tasks?: { readonly items: { readonly properties: Record<'title' | 'reason', TextRule> } }
  }
}

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

/** A rule as ECMAScript reads it (the u flag, as JSON Schema's regex dialect asks): every pattern matches. */
function verdict(rule: TextRule): (text: string) => boolean {
  const patterns = [rule.pattern, ...(rule.allOf ?? []).map((r) => r.pattern)].map((p) => new RegExp(p, 'u'))
  return (text) => patterns.every((p) => p.test(text))
}

/** The generated rule of a status's branch. */
function generated(name: string, status: string, pick: (branch: Branch) => TextRule | undefined): TextRule {
  const branches = (read(join(API, name)) as { oneOf: Branch[] }).oneOf
  const rule = pick(branches.find((b) => b.properties.status.const === status) as Branch)
  if (rule === undefined) throw new Error(`${name} has no such rule when ${status}`)
  return rule
}

const legacySummaryDocument = read(join(LEGACY, 'summary-v1.schema.json')) as {
  properties: { summary: TextRule }
  allOf: { then?: { properties?: { summary?: { pattern: string } } } }[]
}
// The hand-written summary is "not blank" only when task_count is at least 1 (an `if`/`then` of its allOf), which
// every ok report is: the ok rule is the property's pattern plus that one.
const legacySummary: TextRule = {
  pattern: legacySummaryDocument.properties.summary.pattern,
  allOf: legacySummaryDocument.allOf.flatMap((rule) => {
    const pattern = rule.then?.properties?.summary?.pattern
    return pattern === undefined ? [] : [{ pattern }]
  }),
}
const legacyTask = (read(join(LEGACY, 'recommendation-v1.schema.json')) as {
  properties: { tasks: { items: { properties: Record<'title' | 'reason', TextRule> } } }
}).properties.tasks.items.properties

const RULES: readonly [string, TextRule, TextRule][] = [
  ['summary', legacySummary, generated('summary-v1.schema.json', 'ok', (b) => b.properties.summary)],
  ['title', legacyTask.title, generated('recommendation-v1.schema.json', 'ok', (b) => b.properties.tasks?.items.properties.title)],
  ['reason', legacyTask.reason, generated('recommendation-v1.schema.json', 'ok', (b) => b.properties.tasks?.items.properties.reason)],
]

describe('the report text rules in ECMAScript', () => {
  it("reads the hand-written rules it compares with (the summary's conditional \\S included)", () => {
    expect(legacySummary.allOf).toEqual([{ pattern: '\\S' }])
    expect(legacyTask.title.allOf).toEqual([{ pattern: '\\S' }])
    expect(legacyTask.reason.allOf).toEqual([{ pattern: '\\S' }])
  })

  it.each(RULES)('%s: the generated rule differs from the hand-written one only on U+0085 and U+FEFF', (_name, legacy, rule) => {
    const before = verdict(legacy)
    const after = verdict(rule)
    // Code point (hex) -> the texts whose verdict changed, as "<text kind>: <before> -> <after>".
    const differ: Record<string, string[]> = {}
    for (let code = 0; code < 0x110000; code++) {
      if (code >= 0xd800 && code < 0xe000) continue
      const char = String.fromCodePoint(code)
      // The character alone, inside text, doubled before text, and after text (as the Python test does).
      const texts = { alone: char, inside: `a${char}b`, before: `${char}${char}a`, after: `a${char}` }
      for (const [kind, text] of Object.entries(texts)) {
        if (after(text) !== before(text)) {
          ;(differ[code.toString(16)] ??= []).push(`${kind}: ${String(before(text))} -> ${String(after(text))}`)
        }
      }
    }
    expect(differ).toEqual({ '85': ['alone: true -> false'], feff: ['alone: false -> true'] })
  })
})
