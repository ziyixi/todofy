declare module '*?raw' {
  const content: string;
  export default content;
}

/** Vite's eager globs, as the unit tests use them: raw sources of src/, parsed contract fixtures. */
interface ImportMeta {
  glob(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  glob(pattern: string, options: { import: 'default'; eager: true }): Record<string, unknown>;
}
