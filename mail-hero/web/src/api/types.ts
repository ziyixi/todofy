export type ParseState = 'pending' | 'parsing' | 'ready' | 'failed'
export type DeliveryState = 'pending' | 'sending' | 'retry_wait' | 'delivered' | 'failed' | 'cancelled' | 'paused' | 'none' | 'unarranged'

export interface Page<T> { items: T[]; next_cursor: string | null }

export interface MessageSummary {
  id: string
  subject: string
  from: string
  received_at: string
  parse_state: ParseState
  delivery_state?: DeliveryState
  has_attachment?: boolean
  size_bytes?: number
  read_at?: string | null
  preview?: string
  arrival_count?: number
  delivery_count?: number
  content_deleted_at?: string | null
}

export interface Attachment {
  part_id: string
  filename: string
  content_type: string
  size_bytes?: number
  size?: number
  storage_status?: 'stored' | 'omitted'
  omitted_reason?: 'size_limit' | 'message_size_limit' | 'inline_image' | 'capacity'
}

export interface MailboxAddress { address: string; name?: string }

export interface MessageDetail extends MessageSummary {
  version: number
  to?: MailboxAddress[] | string[] | string
  envelope_from?: string
  envelope_to?: string[] | string
  sent_at?: string | null
  rfc_message_id?: string | null
  text?: string
  html?: string
  headers?: Array<{ key: string; value: string }> | Record<string, string | string[]> | string
  attachments?: Attachment[]
  parse_error?: string | null
  needs_review?: boolean
  warnings?: string[]
  text_truncated?: boolean
  original_text_bytes?: number
  html_omitted?: boolean
  attachments_omitted_count?: number
  content_policy_version?: string
  raw_expired_at?: string | null
  search_index_truncated?: boolean
  raw_sha256?: string
  action_snapshot?: string
  endpoint_label?: string
}

export interface Attempt {
  id: string
  attempt_no?: number
  started_at: string
  finished_at?: string | null
  http_status?: number | null
  duration_ms?: number | null
  outcome: string
  error_code?: string | null
  response_preview?: string | null
}

export interface Delivery {
  event_id: string
  message_id: string
  endpoint_id?: string
  endpoint_label?: string
  endpoint_url?: string
  state: DeliveryState
  effective_state?: DeliveryState
  attempt_count: number
  created_at: string
  delivered_at?: string | null
  next_attempt_at?: string | null
  last_error?: string | null
  payload?: unknown
  generation?: number
  replay_of_event_id?: string | null
  paused?: boolean
  subject?: string
  from?: string
  content_deleted?: boolean
}

export interface Endpoint {
  id: string
  label: string
  url: string
  auth_type?: 'bearer' | 'basic' | 'none'
  credential_configured?: boolean
  rate_per_minute?: number
  timeout_seconds?: number
  paused?: boolean
  paused_reason?: string | null
  blocked_reason?: string | null
  blocked_until?: string | null
  /** Automatic route-block rechecks armed on the current revision, including one still
   * scheduled; the block turns permanent when the 8th fails. */
  blocked_rechecks?: number
  version: number
  current_revision_id?: string
  archived_at?: string | null
  pending_count?: number
}

export interface Settings {
  version: number
  receive_address: string
  mode: 'archive' | 'forward'
  current_endpoint_id?: string | null
  send_paused: boolean
  effective_send_paused?: boolean
  retention_days?: number | null
  lifecycle_policy_version?: number
  raw_retention_days?: number | null
  content_retention_days?: number | null
  ledger_retention_days?: number
  /** Global, not frozen per message: owner-resolved delivery exceptions are cleaned this long after their last handling. */
  resolved_retention_days?: number | null
  capacity_bytes?: number
  logical_bytes?: number
  logical_limit_bytes?: number
}

export interface Overview {
  receive_address?: string
  message_count?: number
  pending_count?: number
  failed_count?: number
  delivered_count?: number
  storage_bytes?: number
  capacity_bytes?: number
  last_backup_at?: string | null
  recent_rejections?: number
  warnings?: string[]
  pending_physical_delete_bytes?: number
  capacity_used_bytes?: number | null
  capacity_reserved_bytes?: number | null
  bucket_actual_bytes?: number | null
  account_r2_bytes?: number | null
  alerts?: { configured: boolean; configuration_error: boolean; active: ActiveAlert[]; pending_notifications: number; failed_notifications: number }
}

export interface ActiveAlert { code: string; severity: string; metrics: Record<string, number>; first_seen_at?: string; last_seen_at?: string }

export interface DeliveryStatsCounts {
  succeeded: number
  retried: number
  failed: number
  unknown: number
}

export interface DeliveryStats {
  from: string
  to: string
  bucket: 'hour' | 'day'
  // Present when the request sent tz; buckets are then local days or hours.
  time_zone?: string
  totals: DeliveryStatsCounts
  // end is the next bucket's start (or to); a local DST day is 23 or 25 hours.
  buckets: Array<DeliveryStatsCounts & { start: string; end?: string }>
}

export interface SetupStatus {
  receive_address?: string
  ingest_transport: 'cloudflare'
  checks?: Array<{ id: string; label: string; status: 'ok' | 'warning' | 'error' | 'pending'; detail?: string; action?: string }>
  last_received_at?: string | null
}

export interface RetentionPreview {
  version: number
  days?: number
  raw_retention_days?: number | null
  content_retention_days?: number | null
  ledger_retention_days?: number
  resolved_retention_days?: number | null
  apply_existing?: boolean
  historical_messages?: number
  resolved_messages?: number
  safe_terminal_messages?: number
  historical_content_bytes?: number
  candidates: number | Array<unknown>
  bytes_to_clear: number
  preview_token: string
  expires_at: string
}
