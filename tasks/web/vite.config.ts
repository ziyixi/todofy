import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@dnd-kit/react",
      "@dnd-kit/dom",
      "@dnd-kit/abstract",
      "@dnd-kit/state",
      "@dnd-kit/geometry",
      "@dnd-kit/collision",
    ],
  },
  server: { proxy: { "/api": "http://127.0.0.1:8798" } },
  test: {
    setupFiles: ["./test/setup.ts"],
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
