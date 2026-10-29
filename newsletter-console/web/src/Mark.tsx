import { SHAPES, type Word } from './format.ts';

/** A state as shape and word; the shape is decoration for screen readers, the word carries the state. */
export function Mark({ word, className }: { word: Word; className?: string }) {
  return (
    <span className={`mark ${word.tone}${className ? ` ${className}` : ''}`}>
      <span className="shape" aria-hidden="true">{SHAPES[word.tone]}</span>{word.label}
    </span>
  );
}
