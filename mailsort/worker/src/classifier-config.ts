/** The two classification choices; scheduling, prompt and Gmail writes stay in the existing pipeline. */
export const CODEX_MODEL = 'gpt-6.1-sol';
export const CLAUDE_MODEL = 'claude-opus-5-5';
export const CLASSIFICATION_EFFORT = 'medium';
export const CLASSIFIER_MODELS = { claude: CLAUDE_MODEL, codex: CODEX_MODEL } as const;
