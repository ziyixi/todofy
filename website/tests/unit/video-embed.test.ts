import { describe, expect, it } from "vitest";

import { trustedVideoEmbedUrl } from "../../src/lib/content/video-embed";

describe("trusted video embeds", () => {
  it("rewrites known providers to narrow, canonical iframe URLs", () => {
    expect(trustedVideoEmbedUrl("https://youtu.be/dQw4w9WgXcQ?t=42")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
    expect(trustedVideoEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
    expect(trustedVideoEmbedUrl("https://player.vimeo.com/video/226053498?h=a1599a8ee9")).toBe(
      "https://player.vimeo.com/video/226053498?h=a1599a8ee9",
    );
  });

  it("refuses arbitrary hosts, credentials, ports, and malformed IDs", () => {
    for (const href of [
      "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com:8443/watch?v=dQw4w9WgXcQ",
      "http://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/not-an-id",
      "https://example.com/widget",
    ]) {
      expect(trustedVideoEmbedUrl(href)).toBeUndefined();
    }
  });
});
