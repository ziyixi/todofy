import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  server: { proxy: { "/api": "http://127.0.0.1:8798" } },
  test: { environment: "jsdom", include: ["src/**/*.test.{ts,tsx}"] },
});
