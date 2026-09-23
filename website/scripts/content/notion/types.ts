import type { MediaAsset } from "../types";

export interface PaginatedResponse {
  results: unknown[];
  has_more: boolean;
  next_cursor: string | null;
  request_status?: { type?: string };
}

export interface NotionClientLike {
  dataSources: {
    retrieve(args: { data_source_id: string }): Promise<unknown>;
    query(args: {
      data_source_id: string;
      start_cursor?: string;
      page_size?: number;
    }): Promise<PaginatedResponse>;
  };
  blocks: {
    retrieve?: (args: { block_id: string }) => Promise<unknown>;
    children: {
      list(args: {
        block_id: string;
        start_cursor?: string;
        page_size?: number;
      }): Promise<PaginatedResponse>;
    };
  };
}

export interface NotionBlockNode {
  block: Record<string, unknown>;
  children: NotionBlockNode[];
}

export interface ResolvedImage {
  asset: MediaAsset;
}

export interface RemoteImage {
  url: string;
  notionBlockId: string;
}

export type RemoteFileKind = "file" | "pdf" | "audio" | "video" | "embed";

export interface RemoteFile extends RemoteImage {
  kind: RemoteFileKind;
}

export interface ResolvedFile {
  asset: MediaAsset;
  kind: Exclude<RemoteFileKind, "embed">;
}
