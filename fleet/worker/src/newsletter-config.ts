import type { NewsletterConfigSync } from '@ziyixi/proto/fleet/telemetry/v1/host_report_wire';

export const CONFIG_CHECK_STALE_MS = 30 * 60_000;
export type ConfigState = 'current' | 'pending' | 'failed' | 'stale' | 'pinned' | 'unobserved';

/** Compare only the last observed target; a later publication is outside this report's evidence. */
export function configState(config: NewsletterConfigSync | null | undefined, now: number): ConfigState {
  if (config?.error) return 'failed';
  if (!config?.last_attempt_time) return 'unobserved';
  const attempt = Date.parse(config.last_attempt_time);
  if (attempt > now + 120_000) return 'unobserved';
  if (now - attempt > CONFIG_CHECK_STALE_MS) return 'stale';
  if (!config.active_revision || !config.active_digest) return 'unobserved';
  if (config.pinned_digest) return config.active_digest === config.pinned_digest ? 'pinned' : 'pending';
  if (!config.wanted_revision || !config.wanted_digest) return 'unobserved';
  return config.active_revision === config.wanted_revision && config.active_digest === config.wanted_digest ? 'current' : 'pending';
}

/** Ops carries clocks as numbers; release identities remain in Fleet's authenticated owner view. */
export function configCounters(config: NewsletterConfigSync | null | undefined, now: number): Record<string, number> {
  const counters: Record<string, number> = {};
  if (config?.last_attempt_time) {
    const attempt = Date.parse(config.last_attempt_time);
    if (attempt <= now + 120_000) {
      counters.newsletter_config_last_attempt_at = attempt / 1000;
      counters.newsletter_config_attempt_age_seconds = Math.floor(Math.max(0, now - attempt) / 1000);
    }
  }
  if (config?.last_success_time) {
    const success = Date.parse(config.last_success_time);
    if (success <= now + 120_000) counters.newsletter_config_last_success_at = success / 1000;
  }
  return counters;
}
