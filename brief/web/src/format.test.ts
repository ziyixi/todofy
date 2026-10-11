/**
 * The UI's words: an issue's day read as a calendar day (never shifted by the browser's zone), times in the browser's
 * zone, dollars, tokens, weights, model and step names, poll errors, and links only to web pages.
 */
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt'
import { budget, dayText, issueDay, modelName, pollError, relative, stepName, tokens, topicName, usd, webLink, weight, when } from './format.ts'
import { HOUR, NOW } from './test/fakeServer.ts'

describe('the UI’s words', () => {
  it('reads an issue’s day as the calendar day it names, in any zone', () => {
    expect(issueDay('issues/2026-10-12')).toBe('2026-10-12')
    expect(issueDay('issues/latest')).toBe('')
    expect(dayText('2026-10-12', NOW)).toBe('10月12日 周一')
    expect(dayText('2026-10-17', NOW)).toBe('10月17日 周六')
    expect(dayText('2025-12-31', NOW)).toBe('2025年12月31日 周三')
  })

  it('writes times in the browser’s zone, relative or dated', () => {
    // NOW is 23:00 in Asia/Shanghai (test/setup.ts).
    expect(when(timestampFromMs(NOW - HOUR), NOW)).toBe('今天 22:00')
    expect(when(timestampFromMs(NOW - 24 * HOUR), NOW)).toBe('10月11日 23:00')
    expect(when(undefined, NOW)).toBe('—')
    expect(relative(timestampFromMs(NOW + 2 * HOUR), NOW)).toBe('2 小时后')
    expect(relative(timestampFromMs(NOW - 5 * 60_000), NOW)).toBe('5 分钟前')
    expect(relative(timestampFromMs(NOW + 10_000), NOW)).toBe('马上')
    expect(relative(timestampFromMs(NOW - 3 * 24 * HOUR), NOW)).toBe('3 天前')
  })

  it('writes dollars, tokens and weights', () => {
    expect([usd(0), usd(0.004), usd(0.006), usd(0.8235), usd(12.4)]).toEqual(['$0', '<$0.01', '$0.01', '$0.82', '$12.40'])
    expect([budget(40), budget(12.5)]).toEqual(['$40', '$12.5'])
    expect([tokens(8400), tokens(15_200), tokens(320_000)]).toEqual(['8,400', '1.5 万', '32 万'])
    expect([weight(1), weight(1.125), weight(0.6)]).toEqual(['×1', '×1.13', '×0.6'])
  })

  it('names models, steps, topics and poll errors, and shows an unknown one as it is', () => {
    expect([modelName('claude-opus-5-5'), modelName('claude-haiku-5-5'), modelName('claude-opus-4-8'), modelName('claude-opus-5'), modelName('other-model')]).toEqual(['Opus 5.5', 'Haiku 5.5', 'Opus 4.8', 'Opus 5', 'other-model'])
    expect([stepName('deep_read'), stepName('bisect')]).toEqual(['深读写作', 'bisect'])
    expect([topicName('llm.agents'), topicName('new.topic')]).toEqual(['智能体', 'new.topic'])
    expect([pollError('http_403'), pollError('too_large'), pollError('odd_code')]).toEqual(['HTTP 403', '内容过大', 'odd_code'])
  })

  it('links only web pages', () => {
    expect(webLink('https://synthetic-journal.org/a?b=1')).toBe('https://synthetic-journal.org/a?b=1')
    expect(webLink('http://synthetic-journal.org/a')).toBe('http://synthetic-journal.org/a')
    expect([webLink('javascript:alert(1)'), webLink('data:text/html,x'), webLink('not a url'), webLink('')]).toEqual([null, null, null, null])
  })
})
