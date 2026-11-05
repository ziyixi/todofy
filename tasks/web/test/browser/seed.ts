import { expect, type APIRequestContext } from "@playwright/test";

const ORIGIN = "http://127.0.0.1:8798";

export interface SeededResource {
  id: string;
  name: string;
  title: string;
  etag: string;
}

export async function createResource<T = SeededResource>(
  request: APIRequestContext,
  kind: string,
  fields: Record<string, unknown>,
): Promise<T> {
  const { token } = (await (await request.get("/api/tasks/csrf")).json()) as {
    token: string;
  };
  const response = await request.post(
    `/api/tasks/v1/${kind}?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: ORIGIN },
      data: fields,
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<T>;
}

export async function seedTask<T = SeededResource>(
  request: APIRequestContext,
  fields: Record<string, unknown>,
): Promise<T> {
  return createResource<T>(request, "tasks", fields);
}
