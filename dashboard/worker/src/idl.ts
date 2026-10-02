/**
 * The value lists of dashboard.ui.v1 (proto/dashboard/ui/v1) as the Worker needs them, read from the generated
 * descriptors instead of copied: the IDL is their one definition, so a value added there reaches the registry check,
 * the drift check and the usage read without a second edit.
 */
import { DriftCategory, DriftCategorySchema } from '@ziyixi/proto/dashboard/ui/v1/cloudflare_view_pb';
import { RegistryEntrySchema } from '@ziyixi/proto/dashboard/ui/v1/registry_pb';
import { QuotaResource, QuotaResourceSchema } from '@ziyixi/proto/dashboard/ui/v1/usage_pb';
import { fieldRules, wireEnum } from '@ziyixi/proto/wire-json';
import type { Accent, DriftCategory as DriftCategoryName, IconKey, QuotaResource as QuotaResourceName } from './api-types.ts';

/**
 * What the drift check compares, per Worker, in the IDL's order: the Worker set, Custom Domains, zone routes, cron
 * schedules, binding names and types (secrets by name), the workers.dev / preview URL flags, and whether each
 * personal value is a secret.
 */
export const DRIFT_CATEGORIES: readonly DriftCategoryName[] = wireEnum(DriftCategorySchema, DriftCategory).names;

/** Every quota the dashboard tracks, in the IDL's order (the order of Usage.rows). */
export const QUOTA_RESOURCES: readonly QuotaResourceName[] = wireEnum(QuotaResourceSchema, QuotaResource).names;

/** The icons a registry entry may name (the UI bundles exactly these). */
export const ICON_KEYS = fieldRules(RegistryEntrySchema.field.icon).allowed as readonly IconKey[];

/**
 * Tile accents; each has light and dark tokens in web/src/styles (≥ 3:1 non-text contrast). Rose sits next to the
 * danger colour (--danger-*), so no tile with a health level uses it (test/registry.test.ts).
 */
export const ACCENTS = fieldRules(RegistryEntrySchema.field.accent).allowed as readonly Accent[];
