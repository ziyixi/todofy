export interface Env {
  DB: D1Database;
  MAIL_STORE: R2Bucket;
  BACKUP_STORE?: R2Bucket;
  COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  RECEIVE_ADDRESS: string;
  ACCESS_ISSUER: string;
  ACCESS_AUDIENCE: string;
  ACCESS_OWNER: string;
  ACCESS_OWNER_ALIASES?: string;
  CREDENTIAL_KEY: string;
  WEBHOOK_ALLOWED_HOSTS: string;
  ALERT_WEBHOOK_URL?: string;
  ALERT_WEBHOOK_ALLOWED_HOSTS?: string;
  ALERT_WEBHOOK_TOKEN?: string;
  FORCE_SEND_PAUSED?: string;
  MAINTENANCE_MODE?: string;
  INGEST_DAILY_MESSAGE_LIMIT?: string;
  INGEST_DAILY_BYTE_LIMIT?: string;
  BACKUP_TOKEN?: string;
  BACKUP_RECEIPT_KEY?: string;
  DEV_AUTH_BYPASS?: string;
  ACCESS_SERVICE_ORIGIN?: string;
  ACCESS_CLIENT_ID?: string;
  ACCESS_CLIENT_SECRET?: string;
}

export type Job = { type: 'parse'; key: string } | { type: 'deliver'; eventID: string };

export interface Address { address: string; name?: string }
export interface ParsedMail {
  subject: string;
  from: Address[];
  to: Address[];
  sent_at: string | null;
  rfc_message_id: string | null;
  text: string;
  html: string;
  headers: Array<{ key: string; value: string }>;
  attachments: Array<{ part_id: string; filename: string; content_type: string; size: number; r2_key?: string;
    storage_status?: 'stored' | 'omitted'; omitted_reason?: 'size_limit' | 'message_size_limit' | 'inline_image' | 'capacity' }>;
  text_truncated?: boolean;
  original_text_bytes?: number;
  html_omitted?: boolean;
  attachments_omitted_count?: number;
  content_policy_version?: string;
  needs_review?: boolean;
  warnings?: string[];
}
