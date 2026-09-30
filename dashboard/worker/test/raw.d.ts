declare module '*?raw' {
  const content: string;
  export default content;
}

/** Vite's eager raw glob, as the unit tests use it to scan src/. */
interface ImportMeta {
  glob(pattern: string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
}
