import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ["react", "react-dom"] },
  test: {
    setupFiles: ["./test/setup.ts"],
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    // The mini timer's window takes its stylesheet as text (`mini-timer.css?inline`).
    css: { include: [/mini-timer\.css/] },
  },
});
