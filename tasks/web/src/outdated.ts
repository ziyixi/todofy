import { useSyncExternalStore } from "react";
import { parseStatus } from "@ziyixi/proto/rpc-status";
import { BUILD_HEADER, UNKNOWN_ROUTE } from "../../shared/build";

/** The commit this bundle was built from (vite.config.ts); empty in development. */
const BUILD: string = import.meta.env.VITE_BUILD_SHA;
let outdated = false;
const listeners = new Set<() => void>();

/**
 * A tab opened before a release keeps running its old bundle, which may call routes the new Worker no longer
 * has. An answer from another build marks this tab outdated; so does an answer that does not know the route
 * when either build is unnamed (development). The app then asks for a reload instead of showing an error.
 */
export async function checkBuild(response: Response): Promise<void> {
  if (outdated) return;
  const served = response.headers.get(BUILD_HEADER);
  const stale =
    served && BUILD ? served !== BUILD : await unknownRoute(response);
  if (!stale) return;
  outdated = true;
  for (const listener of listeners) listener();
}

/** The Worker's answer for a path no route has, or for a method its path does not take. */
async function unknownRoute(response: Response): Promise<boolean> {
  if (response.status === 405) return true;
  if (response.status !== 404) return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  return parseStatus(404, body)?.message === UNKNOWN_ROUTE;
}

export function isOutdated(): boolean {
  return outdated;
}

/** Whether an answer showed that a newer build of Tasks is serving. */
export function useOutdated(): boolean {
  return useSyncExternalStore(subscribe, isOutdated);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
