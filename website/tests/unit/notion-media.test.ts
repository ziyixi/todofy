import { describe, expect, it, vi } from "vitest";

import { ContentError } from "../../src/lib/content/errors";
import {
  createMediaResolver,
  fetchMediaWithUrlRefresh,
  fetchWithRetry,
  readLimitedResponseBody,
} from "../../scripts/content/notion/media";

function chunkedResponse(chunks: number[][], onCancel?: () => void): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(Uint8Array.from(chunk));
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { headers: { "content-type": "image/png" } });
}

describe("Notion media streaming limits", () => {
  it("rejects HTTP media before fetching despite allowing HTTP hyperlinks", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
    try {
      const resolveImage = createMediaResolver({ publicDirectory: ".generated/unused-media-test" });
      await expect(
        resolveImage({ notionBlockId: "http-image", url: "http://file.notion.so/image.png" }),
      ).rejects.toMatchObject({ code: "UNSAFE_MEDIA_URL" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("combines a legal chunked response without Content-Length", async () => {
    const response = chunkedResponse([
      [1, 2],
      [3, 4, 5],
    ]);

    await expect(
      readLimitedResponseBody(response, {
        maxImageBytes: 5,
        maxTotalRemainingBytes: 20,
        notionBlockId: "block-1",
      }),
    ).resolves.toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
  });

  it("cancels a chunked response immediately when the per-image limit is crossed", async () => {
    let cancelled = false;
    const response = chunkedResponse(
      [
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 9],
      ],
      () => {
        cancelled = true;
      },
    );

    await expect(
      readLimitedResponseBody(response, {
        maxImageBytes: 5,
        maxTotalRemainingBytes: 20,
        notionBlockId: "block-2",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  it("cancels a chunked response when the remaining total budget is crossed", async () => {
    let cancelled = false;
    const response = chunkedResponse(
      [
        [1, 2],
        [3, 4],
      ],
      () => {
        cancelled = true;
      },
    );

    await expect(
      readLimitedResponseBody(response, {
        maxImageBytes: 20,
        maxTotalRemainingBytes: 3,
        notionBlockId: "block-3",
      }),
    ).rejects.toMatchObject({ code: "MEDIA_TOTAL_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });

  it("honors Retry-After and uses bounded backoff for 429 and 5xx responses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("throttled", { status: 429, headers: { "retry-after": "0" } }),
      )
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleep = vi.fn(async () => undefined);

    const response = await fetchWithRetry(new URL("https://example.com/image.png"), {
      timeoutMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[0], [500]]);
  });

  it("does not retry a permanent client error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    const sleep = vi.fn(async () => undefined);

    const response = await fetchWithRetry(new URL("https://example.com/image.png"), {
      timeoutMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    expect(response.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a bounded network failure before succeeding", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("temporary socket failure"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const sleep = vi.fn(async () => undefined);

    const response = await fetchWithRetry(new URL("https://example.com/image.png"), {
      timeoutMs: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("refreshes an expired signed URL exactly once", async () => {
    const fetchResponse = vi
      .fn()
      .mockRejectedValueOnce(new ContentError("MEDIA_DOWNLOAD_FAILED", "expired", { status: 403 }))
      .mockResolvedValueOnce(new Response("image", { status: 200 }));
    const refreshUrl = vi.fn(async () => "https://file.notion.so/refreshed.png");

    const response = await fetchMediaWithUrlRefresh(
      { notionBlockId: "block-4", url: "https://file.notion.so/expired.png" },
      refreshUrl,
      fetchResponse,
    );

    expect(response.status).toBe(200);
    expect(refreshUrl).toHaveBeenCalledOnce();
    expect(refreshUrl).toHaveBeenCalledWith("block-4");
    expect(fetchResponse.mock.calls).toEqual([
      ["https://file.notion.so/expired.png"],
      ["https://file.notion.so/refreshed.png"],
    ]);
  });

  it("does not refresh a permanent media failure", async () => {
    const originalError = new ContentError("MEDIA_DOWNLOAD_FAILED", "missing", { status: 404 });
    const fetchResponse = vi.fn().mockRejectedValue(originalError);
    const refreshUrl = vi.fn(async () => "https://file.notion.so/refreshed.png");

    await expect(
      fetchMediaWithUrlRefresh(
        { notionBlockId: "block-5", url: "https://file.notion.so/missing.png" },
        refreshUrl,
        fetchResponse,
      ),
    ).rejects.toBe(originalError);
    expect(refreshUrl).not.toHaveBeenCalled();
    expect(fetchResponse).toHaveBeenCalledOnce();
  });
});
