// The content-config texts bundled as strings: wrangler.toml's [[rules]] (type Text) for the Worker, the esbuild
// loader of the workerd harness, and vitest.config.ts's transform for the unit tests.
declare module '*.md' {
  const text: string;
  export default text;
}

declare module '*.yaml' {
  const text: string;
  export default text;
}
