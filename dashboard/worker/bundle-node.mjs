// Bazel's bundler of one Node script with Home's sources: `node bundle-node.mjs <entry> <outfile>`, paths from the cwd.
// The esbuild package's own `esbuild` bin is a native executable, so a build action reaches it through its JS API.
import { build } from 'esbuild'

const [entry, outfile, ...extra] = process.argv.slice(2)
if (!entry || !outfile || extra.length) throw new Error('usage: bundle-node.mjs <entry> <outfile>')
await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'warning' })
