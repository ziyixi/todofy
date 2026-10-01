import { NextResponse } from "next/server";
import { isE2ETestModeEnabled } from "@/features/testing/server/e2e-data";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isE2ETestModeEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
