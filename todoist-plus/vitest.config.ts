import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    // Linked package tests must use the consumer's React-dependent libraries too.
    alias: [
      "lucide-react",
      "@dnd-kit/react",
      "@dnd-kit/react/sortable",
      "@dnd-kit/dom",
      "@dnd-kit/dom/sortable",
      "@dnd-kit/collision",
    ].map((name) => ({
      find: new RegExp(`^${name}$`),
      replacement: fileURLToPath(import.meta.resolve(name)),
    })),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
