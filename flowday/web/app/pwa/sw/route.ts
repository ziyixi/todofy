import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";

let cached: string | null = null;

export function GET() {
  if (!cached) {
    cached = readFileSync(join(process.cwd(), "public", "pwa", "sw.js"), "utf-8");
  }
  return new NextResponse(cached, {
    headers: {
      "Content-Type": "application/javascript",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
