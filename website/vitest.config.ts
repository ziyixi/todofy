import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      name: "cloudflare-workers-stub",
      resolveId(id) {
        if (id === "cloudflare:workers") return "\0cloudflare:workers";
        return undefined;
      },
      load(id) {
        if (id === "\0cloudflare:workers") {
          return (
            "export class WorkerEntrypoint {" +
            " constructor(ctx, env) { this.ctx = ctx; this.env = env; } }"
          );
        }
        return undefined;
      },
    },
  ],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@content": fileURLToPath(new URL("./content", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
