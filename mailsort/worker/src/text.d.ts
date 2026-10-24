// Text is bundled by Wrangler, esbuild in runtime tests, and the unit-test transform.
declare module '*.txt' {
  const text: string;
  export default text;
}
