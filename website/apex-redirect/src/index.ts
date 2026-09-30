import { redirect } from "./redirect";

/**
 * Worker ziyixi-apex-redirect: answers every request on the zone route `ziyixi.science/*` with a 308 to
 * the same path and query on https://www.ziyixi.science, as Vercel's apex redirect did. No bindings, no
 * logs, no subrequests: one URL parse per request. The module exports only the handler.
 */
const worker = {
  fetch(request: Request): Response {
    return redirect(request);
  },
};

export default worker;
