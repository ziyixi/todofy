import { NextResponse } from "next/server";
import type { ServiceResult } from "./service-result";

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function readJsonBody<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

export function getSearchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

export function serviceJson<T>(result: ServiceResult<T>) {
  if (!result.ok) {
    return jsonError(result.error, result.status);
  }
  return NextResponse.json(result.data, {
    status: result.status ?? 200,
  });
}
