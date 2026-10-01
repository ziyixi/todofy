export function fetchNoStore(
  input: RequestInfo | URL,
  init?: Omit<RequestInit, "cache">
) {
  return fetch(input, {
    cache: "no-store",
    ...init,
  });
}

export async function responseJsonOrNull<T>(response: Response): Promise<T | null> {
  if (!response.ok) return null;
  return (await response.json()) as T;
}

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<T | null> {
  return responseJsonOrNull<T>(await fetch(input, init));
}

export async function fetchJsonNoStore<T>(
  input: RequestInfo | URL,
  init?: Omit<RequestInit, "cache">
): Promise<T | null> {
  return responseJsonOrNull<T>(await fetchNoStore(input, init));
}

export function jsonRequestInit(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body: unknown,
  init?: Omit<RequestInit, "method" | "body">
): RequestInit {
  return {
    ...init,
    method,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    body: JSON.stringify(body),
  };
}
