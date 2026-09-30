import { handleButton } from "./buttons";
import { runDetector } from "./detector";
import type { RelayEnv } from "./env";

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Worker ziyixi-notion-publish: the Notion buttons' relay (fetch) and the change detector
 * (scheduled, every 15 minutes). Both only dispatch website-release.yml in the monorepo with fixed
 * inputs. Logs carry codes and counts only, never tokens, headers or Notion content.
 */
const worker = {
  fetch(request: Request, env: RelayEnv): Promise<Response> {
    return handleButton(request, env);
  },

  scheduled(controller: ScheduledController, env: RelayEnv, context: ExecutionContext): void {
    context.waitUntil(
      runDetector(env, new Date(controller.scheduledTime)).then((result) => {
        console.log(JSON.stringify({ relay: "detector", ...result }));
      }),
    );
  },
};

export default worker;
