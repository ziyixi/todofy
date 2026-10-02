// The AIP-160 subset of Mail Hero's list filters (src/native/api-filter.ts): what parses, and that everything else is
// refused rather than read with another meaning. Which fields a list takes is tested with the lists (native-api*.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { FilterError, parseFilter } from '../src/native/api-filter.ts'

const parse = text => parseFilter(text, 400)

test('literals and restrictions, with or without AND and spaces around the comparator', () => {
  assert.deepEqual(parse(''), { literals: [], restrictions: [] })
  assert.deepEqual(parse('   '), { literals: [], restrictions: [] })
  assert.deepEqual(parse('"独立 服务"'), { literals: ['独立 服务'], restrictions: [] })
  assert.deepEqual(parse("'a \\' b'"), { literals: ["a ' b"], restrictions: [] })
  assert.deepEqual(parse('word self-supervised'), { literals: ['word', 'self-supervised'], restrictions: [] })
  assert.deepEqual(parse('state=FAILED'), { literals: [], restrictions: [{ field: 'state', comparator: '=', value: 'FAILED', quoted: false }] })
  assert.deepEqual(parse('"x" AND delivery_state = RETRY_WAIT has_attachments=true'), { literals: ['x'], restrictions: [
    { field: 'delivery_state', comparator: '=', value: 'RETRY_WAIT', quoted: false },
    { field: 'has_attachments', comparator: '=', value: 'true', quoted: false },
  ] })
  assert.deepEqual(parse('attempt_finish_time >= "2026-09-25T00:00:00Z" AND attempt_finish_time<"2026-09-26T00:00:00Z"').restrictions.map(item => [item.comparator, item.value, item.quoted]), [
    ['>=', '2026-09-25T00:00:00Z', true], ['<', '2026-09-26T00:00:00Z', true],
  ])
  assert.deepEqual(parse('receive_time <= "t" receive_time > "u"').restrictions.map(item => item.comparator), ['<=', '>'])
  assert.deepEqual(parse('message = "messages/0b6b4c3e-1111-4222-8333-444455556666"').restrictions[0].value, 'messages/0b6b4c3e-1111-4222-8333-444455556666')
})

test('everything outside the subset is refused', () => {
  for (const text of [
    'a OR b', 'NOT a', '-a', 'a AND', 'AND a', 'a AND AND b', 'state != FAILED', 'state : FAILED', 'a.b = c', 'State = FAILED',
    'state =', '= FAILED', 'state = = FAILED', 'state = OR', 'f(x)', '(a)', 'a*', '"unterminated', '"a"b', '"\\n"', '""', '"   "',
    'state = "a"b', '"x" = y', 'state = FAILED = x',
  ]) assert.throws(() => parse(text), FilterError, text)
  assert.throws(() => parseFilter('x'.repeat(11), 10), FilterError, 'too long')
  assert.doesNotThrow(() => parseFilter('x'.repeat(10), 10))
})

// The shared corpus (proto/testdata/filter-cases.json) every implementation of the AIP-160 subset runs. This parser
// reads the same literals as proto/ts/filter.ts and refuses what it refuses, but for comparisons, which it reads as
// restrictions on purpose (each list then takes only its own fields): there a refusal must be a restriction and no
// literal. The literal cap is each list's (ListMessages takes one), so the corpus's max_literals is applied here.
test('the shared filter corpus: the same literals, the same refusals but for restrictions, and quoted searches round-trip', async () => {
  const { quoteLiteral } = await import('@ziyixi/proto/filter')
  const corpus = JSON.parse(readFileSync(new URL('../../../proto/testdata/filter-cases.json', import.meta.url), 'utf8'))
  assert.ok(corpus.parse.length >= 29 && corpus.quote.length >= 4)
  let restrictionsOnly = 0
  for (const item of corpus.parse) {
    let parsed = null
    try { parsed = parse(item.filter) } catch (error) { assert.ok(error instanceof FilterError, item.name) }
    if (item.error) {
      if (parsed === null || parsed.literals.length > corpus.max_literals) continue
      assert.deepEqual(parsed.literals, [], `${item.name}: a refusal this parser accepts can only be a restriction`)
      assert.ok(parsed.restrictions.length > 0, item.name)
      restrictionsOnly++
    } else {
      assert.notEqual(parsed, null, item.name)
      assert.deepEqual([parsed.literals, parsed.restrictions], [item.literals, []], item.name)
    }
  }
  assert.equal(restrictionsOnly, 1, 'only `year>2020` differs (a comparison); a new difference is a decision, not drift')
  for (const item of corpus.quote) {
    assert.equal(quoteLiteral(item.text), item.filter, item.name)
    const text = item.text.trim()
    assert.deepEqual(parse(item.filter), { literals: text === '' ? [] : [text], restrictions: [] }, item.name)
  }
})
