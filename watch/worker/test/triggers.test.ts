import { describe, expect, it } from 'vitest';
import { buildContent, type Content } from '../src/content.ts';
import type { TriggerConfig } from '../src/config.ts';
import { evaluate, keptDiff } from '../src/triggers.ts';

const text = (...lines: string[]): Content => ({ lines, keys: lines, number: null, availability: null });
const value = (number: string | null, availability: string | null = null): Content => ({ lines: [`v ${String(number)} ${String(availability)}`], keys: [], number, availability });

describe('AnyChangeTrigger (against the notified state)', () => {
  const trigger: TriggerConfig = { kind: 'any_change', minLines: 3, minPercent: 50 };

  it('fires at its floors of lines and share, else BELOW_THRESHOLD', () => {
    const base = text('a', 'b', 'c', 'd');
    expect(evaluate(trigger, base, base, text('a', 'b', 'c', 'x'))).toMatchObject({ fired: false, reason: 'BELOW_THRESHOLD', added: 1, removed: 1 });
    expect(evaluate(trigger, base, base, text('a', 'b', 'x', 'y'))).toMatchObject({ fired: true, reason: null, summary: '新增 2 行，删除 2 行' });
  });
});

describe('edges between the previous check and this one', () => {
  it('TextTrigger: appears fires only where the previous check lacked it (a reappearance fires again)', () => {
    const trigger: TriggerConfig = { kind: 'text_appears', text: 'In Stock' };
    const notified = text('sold out');
    expect(evaluate(trigger, notified, notified, text('in stock now')).fired).toBe(true);
    expect(evaluate(trigger, text('in stock'), text('in stock now'), text('in stock, hurry')).fired).toBe(false);
    // Notified "in stock", sold out at the previous check, back now: news.
    expect(evaluate(trigger, text('in stock'), text('sold out'), text('in stock again')).fired).toBe(true);
    const gone: TriggerConfig = { kind: 'text_disappears', text: 'sale' };
    expect(evaluate(gone, text('big sale'), text('big sale'), text('no deals')).summary).toBe('关注的文字消失了');
  });

  it('NumberTrigger: thresholds are crossed from the previous check, change_percent is against the notified value', () => {
    const lower: TriggerConfig = { kind: 'number', upper: null, lower: 100, changePercent: 0, label: '' };
    expect(evaluate(lower, value('120'), value('110'), value('99'))).toMatchObject({ fired: true, previous: '110', current: '99', summary: '数值降到下限以下' });
    expect(evaluate(lower, value('120'), value('99'), value('95')).fired).toBe(false);
    const upper: TriggerConfig = { kind: 'number', upper: 10, lower: null, changePercent: 0, label: '' };
    expect(evaluate(upper, value('5'), value('5'), value('10')).fired).toBe(true);
    const share: TriggerConfig = { kind: 'number', upper: null, lower: null, changePercent: 50, label: '' };
    expect(evaluate(share, value('200'), value('150'), value('99'))).toMatchObject({ fired: true, previous: '200', current: '99' });
    expect(evaluate(share, value('200'), value('150'), value('120')).fired).toBe(false);
  });

  it('AvailabilityTrigger: any change, or only becoming buyable', () => {
    const any: TriggerConfig = { kind: 'availability', onlyWhenAvailable: false };
    const buyable: TriggerConfig = { kind: 'availability', onlyWhenAvailable: true };
    const notified = value(null, 'InStock');
    expect(evaluate(any, notified, notified, value(null, 'OutOfStock')).fired).toBe(true);
    expect(evaluate(buyable, notified, notified, value(null, 'OutOfStock')).fired).toBe(false);
    expect(evaluate(buyable, notified, value(null, 'OutOfStock'), value(null, 'PreOrder'))).toMatchObject({ fired: true, previous: 'OutOfStock', current: 'PreOrder', summary: '可以购买了' });
  });
});

describe('NewItemTrigger (against the notified keys)', () => {
  it('counts keys the notified state lacks', () => {
    const trigger: TriggerConfig = { kind: 'new_item', minItems: 2 };
    const notified: Content = { lines: ['A', 'B'], keys: ['1', '2'], number: null, availability: null };
    const one: Content = { lines: ['A', 'B', 'C'], keys: ['1', '2', '3'], number: null, availability: null };
    const two: Content = { lines: ['A', 'B', 'C', 'D'], keys: ['1', '2', '3', '4'], number: null, availability: null };
    expect(evaluate(trigger, notified, one, one)).toMatchObject({ fired: false, reason: 'TRIGGER_NOT_MET' });
    expect(evaluate(trigger, notified, one, two)).toMatchObject({ fired: true, summary: '新增 2 项' });
  });
});

describe('the kept diff and stage 3 for triggers', () => {
  it('keeps at most 200 lines of at most 500 characters', () => {
    const many = Array.from({ length: 300 }, (_, i) => `${'x'.repeat(600)}${String(i)}`);
    const kept = keptDiff(evaluate({ kind: 'any_change', minLines: 1, minPercent: 0 }, text(), text(), text(...many)).diff);
    expect(kept.lines).toHaveLength(200);
    expect(kept.lines[0]?.text.length).toBe(500);
    expect(kept.truncated).toBe(true);
  });

  it('reads the number from unmasked lines, and a missing value is VALUE_MISSING', () => {
    const raw = { lines: ['Visitors 1,234', 'Price: 99.50'], items: null, availability: null, truncated: false };
    const normalize = { ignoredLines: [], defaultMasks: true, maskNumbers: true };
    const built = buildContent(raw, normalize, { kind: 'number', upper: null, lower: 50, changePercent: 0, label: 'Price:' });
    expect(built.ok && built.content.number).toBe('99.5');
    expect(built.ok && built.content.lines).toEqual(['Visitors ⟨数字⟩', 'Price: ⟨数字⟩']);
    expect(buildContent(raw, normalize, { kind: 'availability', onlyWhenAvailable: false })).toEqual({ ok: false, failure: 'VALUE_MISSING' });
  });
});
