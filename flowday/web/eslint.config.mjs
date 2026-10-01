import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Every request to the Worker goes through lib/client/http.ts (CSRF, retry, visible failures): fetch() anywhere
// else in the app is an error. Tests, scripts and the service worker are not app code.
const NO_DIRECT_FETCH = {
  files: ["app/**", "components/**", "features/**", "lib/**"],
  ignores: ["lib/client/http.ts"],
  rules: {
    "no-restricted-globals": [
      "error",
      { name: "fetch", message: "Use apiGet/apiSend from @/lib/client/http (CSRF, retry, visible failures)." },
    ],
    "no-restricted-properties": [
      "error",
      { object: "window", property: "fetch", message: "Use apiGet/apiSend from @/lib/client/http." },
      { object: "globalThis", property: "fetch", message: "Use apiGet/apiSend from @/lib/client/http." },
      { object: "self", property: "fetch", message: "Use apiGet/apiSend from @/lib/client/http." },
    ],
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  NO_DIRECT_FETCH,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "output/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
