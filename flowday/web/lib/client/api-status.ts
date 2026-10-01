/**
 * What the API status banner shows: the last failed write or an expired sign-in. A session expiry stays until the
 * page reloads (every request would fail the same way); other failures can be dismissed.
 */
import { create } from "zustand";

export interface ApiStatusError {
  kind: "session" | "network" | "http";
  message: string;
}

interface ApiStatusState {
  error: ApiStatusError | null;
  report: (error: ApiStatusError) => void;
  dismiss: () => void;
}

export const useApiStatus = create<ApiStatusState>()((set, get) => ({
  error: null,
  report: (error) => {
    // An expired sign-in outranks any later failure (they are its consequence).
    if (get().error?.kind === "session") return;
    set({ error: { kind: error.kind, message: error.message } });
  },
  dismiss: () => {
    if (get().error?.kind === "session") return;
    set({ error: null });
  },
}));
