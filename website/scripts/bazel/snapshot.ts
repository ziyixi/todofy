import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validatePreparedContent } from "../content/validate.ts";

/** Stage the existing validated public content as a declared Bazel repository input. */
export async function stagePreparedSnapshot(root: string, destination: string): Promise<void> {
  await validatePreparedContent(path.join(root, ".generated/content"), path.join(root, "public"));
  await mkdir(path.join(destination, ".generated/content"), { recursive: true });
  for (const file of ["snapshot.json", "manifest.json", "registry.json"]) {
    await cp(
      path.join(root, ".generated/content", file),
      path.join(destination, ".generated/content", file),
    );
  }
  await cp(
    path.join(root, ".generated/images.json"),
    path.join(destination, ".generated/images.json"),
  );
  for (const folder of ["media", "_img"]) {
    await mkdir(path.join(destination, "public"), { recursive: true });
    await cp(path.join(root, "public", folder), path.join(destination, "public", folder), {
      recursive: true,
    });
  }
  await writeFile(
    path.join(destination, "BUILD.bazel"),
    'filegroup(name="files",srcs=glob([".generated/**","public/media/**","public/_img/**"],allow_empty=True),visibility=["//visibility:public"])\n',
  );
  await writeFile(path.join(destination, "REPO.bazel"), "");
}
