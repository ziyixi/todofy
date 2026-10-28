import { label, SHAPES, tone } from './format.ts';

/** A state as shape + word; colour only reinforces them. */
export function Mark({ state, text }: { state: string; text?: string }) {
  const level = tone(state);
  return <span className={`mark ${level}`}><span aria-hidden="true">{SHAPES[level]} </span>{text ?? label(state)}</span>;
}
