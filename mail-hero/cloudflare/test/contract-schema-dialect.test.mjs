// mail.received.v1's "not blank" (a subject or a text) as an ECMAScript validator reads it: the generated schema
// (contracts/mail-received-v1/mail-received-v1.schema.json, from proto/mailhero/webhook/v1/mail_received.proto)
// against the hand-written one it replaced (contracts/mail-received-v1/legacy/, frozen). JSON Schema specifies ECMA-262
// regular expressions, so this is the published meaning; todofy/tests/unit/test_mail_received_schema_legacy.py compares
// the same rule in Python's dialect, which Todofy's str.strip() follows and where nothing changed.
//
// The two differ on exactly six characters, by design (mail_received.proto's header): the hand-written "\S" read as
// ECMAScript took U+001C-U+001F and U+0085 for visible characters and U+FEFF for whitespace, the reverse of Todofy. A
// subject and text made only of the former were valid and are refused now; made only of U+FEFF, refused and valid now.
// Any other difference is drift and fails here.
//
// A reader may compile a pattern with or without the u flag (ajv's unicodeRegExp option, a plain `new RegExp`), so both
// are compared and must agree on every text: without u a character above U+FFFF is two UTF-16 code units, and a
// pattern that named one in a class (as a range up to U+10FFFF once did) would refuse the second half of every emoji.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CONTRACT = new URL('../../../contracts/mail-received-v1/', import.meta.url)
const read = path => JSON.parse(readFileSync(new URL(path, CONTRACT), 'utf8'))
/** The pattern of the subject's branch of Mail's anyOf (the text's is the same rule). */
const subjectRule = schema => schema.properties.message.anyOf[0].properties.subject.pattern

test('the generated "not blank" differs from the hand-written one in ECMAScript only on U+001C-U+001F, U+0085 and U+FEFF', () => {
  const legacy = subjectRule(read('legacy/mail-received-v1.schema.json'))
  assert.equal(legacy, '\\S')
  const generated = subjectRule(read('mail-received-v1.schema.json'))
  assert.deepEqual(read('mail-received-v1.schema.json').properties.message.anyOf.map(branch => Object.keys(branch.properties)), [['subject'], ['text']])
  for (const flags of ['u', '']) {
    const before = new RegExp(legacy, flags), after = new RegExp(generated, flags)
    // Code point (hex) -> the texts whose verdict changed, as "<text kind>: <before> -> <after>".
    // At most 16 code points are recorded, so that a broken pattern fails with a readable difference.
    const differ = {}
    for (let code = 0; code < 0x110000 && Object.keys(differ).length < 16; code++) {
      if (code >= 0xd800 && code < 0xe000) continue
      const char = String.fromCodePoint(code)
      // The character alone, inside text, doubled before text, and after text (as the Python test does).
      for (const [kind, text] of Object.entries({ alone: char, inside: `a${char}b`, before: `${char}${char}a`, after: `a${char}` })) {
        if (after.test(text) !== before.test(text)) (differ[code.toString(16)] ??= []).push(`${kind}: ${before.test(text)} -> ${after.test(text)}`)
      }
    }
    const visibleBefore = ['alone: true -> false']
    assert.deepEqual(differ, { '1c': visibleBefore, '1d': visibleBefore, '1e': visibleBefore, '1f': visibleBefore, '85': visibleBefore, feff: ['alone: false -> true'] }, `flags "${flags}"`)
  }
})

test('the generated "not blank" reads the same with and without the u flag, characters above U+FFFF included', () => {
  const generated = subjectRule(read('mail-received-v1.schema.json'))
  const unicode = new RegExp(generated, 'u'), units = new RegExp(generated)
  for (const text of ['Hello \u{1f600}', '\u{1f600}', 'a\u{1f600}b', '\u{10ffff}', ' \u{1f600} ', '\u{1f600}\n', '\u3000\u{20000}']) {
    assert.equal(units.test(text), true, JSON.stringify(text))
    assert.equal(unicode.test(text), true, JSON.stringify(text))
  }
  for (const text of ['', ' ', '\u3000\n', '\u2028\u2029']) assert.equal(units.test(text) || unicode.test(text), false, JSON.stringify(text))
  // Every character of Unicode alone, after a visible one and before one: one verdict for both readings.
  for (let code = 0; code < 0x110000; code++) {
    const char = String.fromCodePoint(code)
    for (const text of [char, `a${char}`, `${char}a`]) assert.equal(units.test(text), unicode.test(text), `U+${code.toString(16)} in ${JSON.stringify(text)}`)
  }
})
