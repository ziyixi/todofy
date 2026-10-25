/** The same structured answer and exact message coverage for both classification engines. */
export interface ClassificationEmail {
  readonly id: string;
  readonly subject: string;
  readonly sender: string;
  readonly received_at: string;
  readonly evaluated_at: string;
  readonly time_zone: string;
  readonly body: string;
  readonly body_truncated: boolean;
}
export interface ClassificationItem {
  readonly id: string;
  readonly bucket: 'P1' | 'P2' | 'P3' | 'P4';
  readonly reason: string;
}
export const CLASSIFICATION_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, bucket: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] }, reason: { type: 'string' } },
        required: ['id', 'bucket', 'reason'], additionalProperties: false,
      },
    },
  },
  required: ['items'], additionalProperties: false,
};

export function classificationItems(value: unknown, ids: ReadonlySet<string>): ClassificationItem[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('items' in value) || !Array.isArray(value.items) || value.items.length !== ids.size) return null;
  const seen = new Set<string>();
  const items: ClassificationItem[] = [];
  for (const item of value.items as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3 || !('id' in item) || !('bucket' in item) || !('reason' in item)) return null;
    const { id, bucket, reason } = item;
    if (typeof id !== 'string' || !ids.has(id) || seen.has(id) || (bucket !== 'P1' && bucket !== 'P2' && bucket !== 'P3' && bucket !== 'P4') || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) return null;
    seen.add(id);
    items.push({ id, bucket, reason });
  }
  return items;
}
