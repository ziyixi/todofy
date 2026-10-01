import { NextResponse } from "next/server";
import {
  clearE2ETestData,
  isE2ETestModeEnabled,
} from "@/features/testing/server/e2e-data";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!isE2ETestModeEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  clearE2ETestData();
  return NextResponse.json({ ok: true });
}
