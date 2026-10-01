// Global ambient type declarations for browser APIs that TypeScript's
// built-in lib.dom does not yet include. Keeping these in one place avoids
// duplicate-declaration errors that arise when individual modules redeclare
// the same Window/Screen augmentations.

interface IdleDetectorInstance extends EventTarget {
  userState: "active" | "idle" | null;
  screenState: "locked" | "unlocked" | null;
  start(options?: { threshold?: number; signal?: AbortSignal }): Promise<void>;
}

interface IdleDetectorCtor {
  new (): IdleDetectorInstance;
  requestPermission(): Promise<"granted" | "denied">;
}

interface DocumentPictureInPicture {
  requestWindow: (options?: {
    width?: number;
    height?: number;
  }) => Promise<Window>;
  window: Window | null;
}

interface Window {
  IdleDetector?: IdleDetectorCtor;
  documentPictureInPicture?: DocumentPictureInPicture;
}

interface Screen {
  availLeft?: number;
  availTop?: number;
}
