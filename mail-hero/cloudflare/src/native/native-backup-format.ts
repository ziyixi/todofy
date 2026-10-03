/** Ordinary files in private R2. Original R2 metadata lives in source-manifest.json. */
export interface NativeBackupObject {
  key: string; size: number; etag: string; uploaded: string;
  customMetadata: Record<string, string>; httpMetadata: Record<string, unknown>;
}
export interface NativeBackupFile {
  path: string; bytes: number; sha256: string;
  kind: 'control' | 'schema' | 'database' | 'object' | 'source_manifest' | 'deletions';
  object_key?: string;
}
export interface NativeBackupManifest {
  version: 2; format: 'mailhero.native-backup.v2'; encrypted: false;
  backup_id: string; created_at: string; cut_at: string; cut_seq: number;
  build_sha: string | null; source_manifest_sha256: string; credential_key_included: false;
  files: NativeBackupFile[];
}
export interface NativeBackupMarker {
  version: 2; backup_id: string; key: string; sha256: string; manifest_sha256: string;
  created_at: string; verified_at: string; size_bytes: number; object_count: number;
  proof: 'native_readback_verified';
}
