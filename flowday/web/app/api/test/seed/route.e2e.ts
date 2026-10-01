import { NextResponse } from "next/server";
import {
  clearE2ETestData,
  isE2ETestModeEnabled,
  seedE2ETestData,
  type E2ESeedPayload,
} from "@/features/testing/server/e2e-data";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!isE2ETestModeEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const payload = (await request.json()) as E2ESeedPayload & { resetFirst?: boolean };
  if (payload.resetFirst !== false) {
    clearE2ETestData();
  }
  seedE2ETestData(payload);
  return NextResponse.json({ ok: true });
}
