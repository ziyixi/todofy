import { beforeEach } from "vitest";
import { setCsrfTokenForTests } from "@/lib/client/http";
import { useApiStatus } from "@/lib/client/api-status";
import { FAKE_CSRF_TOKEN, resetFakeWorker } from "./helpers/fake-worker";

// Each test starts with an empty in-memory API (helpers/fake-worker.ts), a known CSRF token (so a write does not
// first fetch /api/csrf; http.test.ts covers that handshake) and no banner. Tests that talk to the API stub the
// global fetch with fakeFetch (or their own fake).
beforeEach(() => {
  resetFakeWorker();
  setCsrfTokenForTests(FAKE_CSRF_TOKEN);
  useApiStatus.setState({ error: null });
});
