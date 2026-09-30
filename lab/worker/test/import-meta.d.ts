/** Vite's eager globs, as the unit tests use them: parsed contract fixtures. */
interface ImportMeta {
  glob(pattern: string, options: { import: 'default'; eager: true }): Record<string, unknown>;
}
