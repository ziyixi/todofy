import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The site's own source and build definitions, as declared by its Bazel release target. */
export function sourcePaths(labels: string): string[] {
  return [
    ...new Set(
      labels
        .trim()
        .split("\n")
        .filter((label) => label.startsWith("//"))
        .map((label) => {
          const [directory, file] = label.slice(2).split(":");
          return [directory, file].filter(Boolean).join("/");
        })
        .concat([
          "MODULE.bazel",
          "MODULE.bazel.lock",
          ".bazelrc",
          ".bazelversion",
          ".python-version",
          "package.json",
          "pnpm-workspace.yaml",
          "pnpm-lock.yaml",
        ]),
    ),
  ].sort();
}

export async function websiteCodeSha(workspace: string): Promise<string> {
  const { stdout: labels } = await execFileAsync(
    "bazel",
    [
      "query",
      'filter("^//", kind("source file", deps(//website:release)) union buildfiles(deps(//website:release)))',
      "--output=label",
    ],
    { cwd: workspace },
  );
  const { stdout } = await execFileAsync(
    "git",
    ["log", "-1", "--format=%H", "--", ...sourcePaths(labels)],
    { cwd: workspace },
  );
  const sha = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha))
    throw new Error("Could not resolve the website source identity.");
  return sha;
}
