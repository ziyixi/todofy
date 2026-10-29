/** Defaults for settings saved before the owner could choose a Router route. */
import type { ClassificationProviderName, SettingsValue } from './settings.ts';
export const CODEX_MODEL = 'gpt-6.1-sol';
export const CLAUDE_MODEL = 'claude-opus-5-5';
export const CLASSIFICATION_EFFORT = 'medium';
export const CLASSIFIER_MODELS = { claude: CLAUDE_MODEL, codex: CODEX_MODEL } as const;

export function classifierModel(settings: Pick<SettingsValue, 'classificationProvider' | 'classificationModel'>): string {
  return settings.classificationModel || (settings.classificationProvider === 'claude' ? CLAUDE_MODEL : CODEX_MODEL);
}

export function classifierEffort(settings: Pick<SettingsValue, 'classificationEffort'>): string {
  return settings.classificationEffort ?? CLASSIFICATION_EFFORT;
}

export function classificationProvider(provider: string): ClassificationProviderName | null {
  return provider === 'anthropic' ? 'claude' : provider === 'codex' || provider === 'openai' || provider === 'google' ? provider : null;
}
