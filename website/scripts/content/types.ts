import type { ContentSourceModeSchema, MediaAssetSchema, Post } from "../../src/lib/content/schema";
import type { z } from "zod";

export type SourceMode = z.infer<typeof ContentSourceModeSchema>;
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export interface SourceDiagnostics {
  draftCount: number;
  futureCount: number;
  warnings: string[];
}

export interface PreparedSource {
  posts: Post[];
  media: MediaAsset[];
  diagnostics: SourceDiagnostics;
}

export interface SourceContext {
  cutoff: Date;
  publicDirectory: string;
}
