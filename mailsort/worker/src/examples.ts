/**
 * The historical example store: masked summaries of mails the owner corrected or confirmed, with the embeddings the
 * retired Workers AI path made, in MailsortState's SQLite. Nothing adds or reads examples any more; they stay readable
 * (ListExamples) until the owner deletes them, and a withdrawn verdict or a deleted label removes its own.
 */
import type { Store } from './store.ts';

export function deleteExampleOf(store: Store, messageId: string): void {
  store.run(`DELETE FROM examples WHERE message_id = ?`, messageId);
}

export function deleteExample(store: Store, id: string): boolean {
  return store.run(`DELETE FROM examples WHERE id = ?`, id) > 0;
}

export function deleteExamplesOfLabel(store: Store, labelId: string): void {
  store.run(`DELETE FROM examples WHERE label_id = ?`, labelId);
}
