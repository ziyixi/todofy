import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { prepareNotionSourceMock } = vi.hoisted(() => ({
  prepareNotionSourceMock: vi.fn(),
}));

vi.mock("../../scripts/content/adapters/notion", () => ({
  prepareNotionSource: prepareNotionSourceMock,
}));

import { commitMediaAndBundleAtomically, prepareContent } from "../../scripts/content/prepare";
import { validatePreparedContent } from "../../scripts/content/validate";
import { emptyContentRegistry } from "../../src/lib/content/registry";

const temporaryDirectories: string[] = [];

async function temporaryWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "ziyixi-media-transaction-test-"));
  temporaryDirectories.push(root);
  return {
    root,
    outputDirectory: path.join(root, "generated", "content"),
    publicDirectory: path.join(root, "public"),
  };
}

afterEach(async () => {
  prepareNotionSourceMock.mockReset();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("media and snapshot transaction", () => {
  it("does not publish media written before a Notion synchronization failure", async () => {
    const paths = await temporaryWorkspace();
    const bytes = Buffer.from("incomplete-media");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const filename = `${digest}.png`;
    prepareNotionSourceMock.mockImplementationOnce(async (context: { publicDirectory: string }) => {
      const mediaDirectory = path.join(context.publicDirectory, "media");
      await mkdir(mediaDirectory, { recursive: true });
      await writeFile(path.join(mediaDirectory, filename), bytes);
      throw new Error("later Notion page failed");
    });

    await expect(
      prepareContent({
        source: "notion",
        baseline: emptyContentRegistry(),
        notion: {
          token: "test-token",
          dataSourceId: "test-data-source",
          apiVersion: "2026-03-11",
        },
        outputDirectory: paths.outputDirectory,
        publicDirectory: paths.publicDirectory,
      }),
    ).rejects.toThrow("later Notion page failed");

    await expect(access(path.join(paths.publicDirectory, "media", filename))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("restores pruned media and removes newly installed media when bundle commit fails", async () => {
    const paths = await temporaryWorkspace();
    const transactionDirectory = path.join(paths.root, "transaction");
    const stagedMediaDirectory = path.join(transactionDirectory, "public", "media");
    const liveMediaDirectory = path.join(paths.publicDirectory, "media");
    await Promise.all([
      mkdir(stagedMediaDirectory, { recursive: true }),
      mkdir(liveMediaDirectory, { recursive: true }),
    ]);

    const oldBytes = Buffer.from("old-media");
    const oldHash = createHash("sha256").update(oldBytes).digest("hex");
    const oldPath = path.join(liveMediaDirectory, `${oldHash}.png`);
    await writeFile(oldPath, oldBytes);

    const newBytes = Buffer.from("new-media");
    const newHash = createHash("sha256").update(newBytes).digest("hex");
    const newFilename = `${newHash}.png`;
    const newPath = path.join(liveMediaDirectory, newFilename);
    await writeFile(path.join(stagedMediaDirectory, newFilename), newBytes);

    await expect(
      commitMediaAndBundleAtomically({
        publicDirectory: paths.publicDirectory,
        stagedMediaDirectory,
        transactionDirectory,
        assets: [
          {
            path: `/media/${newFilename}`,
            sha256: newHash,
            mimeType: "image/png",
            sizeBytes: newBytes.byteLength,
            width: 1,
            height: 1,
          },
        ],
        commitBundle: async () => {
          throw new Error("bundle commit failed");
        },
      }),
    ).rejects.toThrow("bundle commit failed");

    await expect(readFile(oldPath)).resolves.toEqual(oldBytes);
    await expect(access(newPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a generated media file that the committed snapshot does not reference", async () => {
    const paths = await temporaryWorkspace();
    await prepareContent({
      source: "empty",
      baseline: emptyContentRegistry(),
      outputDirectory: paths.outputDirectory,
      publicDirectory: paths.publicDirectory,
    });
    const bytes = Buffer.from("orphan-media");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const mediaDirectory = path.join(paths.publicDirectory, "media");
    await mkdir(mediaDirectory, { recursive: true });
    await writeFile(path.join(mediaDirectory, `${digest}.png`), bytes);

    await expect(
      validatePreparedContent(paths.outputDirectory, paths.publicDirectory, {
        expectedSource: "empty",
      }),
    ).rejects.toMatchObject({ code: "ORPHAN_MEDIA_FILE" });
  });
});
