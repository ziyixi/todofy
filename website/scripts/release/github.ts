import { RELEASE_ENVIRONMENT, RELEASE_TASK, type ReleasePayload } from "./payload";

export type Fetch = typeof fetch;

export interface DeploymentRow {
  id: number;
  created_at: string;
  payload: unknown;
}

interface StatusRow {
  id: number;
  created_at: string;
  state: string;
}

export const DEPLOYMENT_STATES = [
  "in_progress",
  "success",
  "failure",
  "error",
  "inactive",
] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

function newestFirst<T extends { id: number; created_at: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (left, right) => right.created_at.localeCompare(left.created_at) || right.id - left.id,
  );
}

/**
 * The few GitHub REST calls a release makes, with the job's GITHUB_TOKEN (deployments: write,
 * contents: read). Records of a repository other than `repository` (the legacy import) are read
 * with the same token, which can read any public repository.
 */
export class GitHubClient {
  constructor(
    private readonly options: {
      apiUrl: string;
      token: string;
      repository: string;
      fetchImpl?: Fetch;
    },
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
      throw new Error("GITHUB_REPOSITORY must be owner/name.");
    }
  }

  get repository(): string {
    return this.options.repository;
  }

  async request<T>(method: string, path: string, body?: unknown, repository?: string): Promise<T> {
    // Only the steps that read or write release records get the token (website-release.yml).
    if (!this.options.token) throw new Error("GITHUB_TOKEN is not available to this step.");
    const repo = repository ?? this.options.repository;
    const response = await (this.options.fetchImpl ?? fetch)(
      `${this.options.apiUrl}/repos/${repo}${path}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.options.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      // Never echo the response body: it can quote the request.
      throw new Error(`GitHub ${method} ${path} failed with HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  }

  async all<T>(path: string, repository?: string): Promise<T[]> {
    const separator = path.includes("?") ? "&" : "?";
    const rows: T[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await this.request<unknown>(
        "GET",
        `${path}${separator}per_page=100&page=${page}`,
        undefined,
        repository,
      );
      if (!Array.isArray(batch)) throw new Error("GitHub returned a non-array page.");
      rows.push(...(batch as T[]));
      if (batch.length < 100) return rows;
    }
    throw new Error("GitHub pagination exceeded 10,000 records.");
  }

  /** website-release records, newest first. */
  async releaseRecords(repository?: string): Promise<DeploymentRow[]> {
    const rows = await this.all<DeploymentRow>(
      `/deployments?environment=${RELEASE_ENVIRONMENT}&task=${RELEASE_TASK}`,
      repository,
    );
    return newestFirst(rows);
  }

  async latestState(deploymentId: number | string, repository?: string): Promise<string> {
    const statuses = newestFirst(
      await this.all<StatusRow>(`/deployments/${deploymentId}/statuses`, repository),
    );
    return statuses[0]?.state ?? "missing";
  }

  async createRecord(payload: ReleasePayload, ref: string): Promise<number> {
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error("A release record needs a full commit SHA.");
    const created = await this.request<{ id: number }>("POST", "/deployments", {
      ref,
      task: RELEASE_TASK,
      auto_merge: false,
      required_contexts: [],
      environment: RELEASE_ENVIRONMENT,
      description: "Verified website version awaiting deployment",
      transient_environment: false,
      production_environment: true,
      payload,
    });
    if (!Number.isSafeInteger(created.id)) throw new Error("GitHub returned no deployment ID.");
    return created.id;
  }

  async setState(
    deploymentId: number | string,
    state: DeploymentState,
    options: { description: string; environmentUrl?: string | null; logUrl: string },
  ): Promise<void> {
    if (options.description.length > 140) throw new Error("Status description is too long.");
    await this.request("POST", `/deployments/${deploymentId}/statuses`, {
      state,
      description: options.description,
      log_url: options.logUrl,
      auto_inactive: false,
      ...(options.environmentUrl ? { environment_url: options.environmentUrl } : {}),
    });
  }
}
