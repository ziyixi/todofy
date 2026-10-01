import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json(
    {
      name: "FlowDay",
      short_name: "FlowDay",
      description:
        "A visual daily task flow planner with Todoist integration — plan your day, track your time, review your work.",
      start_url: "/",
      id: "/",
      display: "standalone",
      display_override: ["window-controls-overlay", "standalone"],
      background_color: "#0a0a0a",
      theme_color: "#0a0a0a",
      orientation: "any",
      categories: ["productivity", "utilities"],
      icons: [
        { src: "/pwa/icon-192x192.png", sizes: "192x192", type: "image/png" },
        { src: "/pwa/icon-512x512.png", sizes: "512x512", type: "image/png" },
        {
          src: "/pwa/icon-maskable-512x512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "maskable",
        },
        { src: "/pwa/icon.svg", sizes: "any", type: "image/svg+xml" },
      ],
      shortcuts: [
        {
          name: "Today's Flow",
          short_name: "Today",
          description: "Jump to today's task flow",
          url: "/",
          icons: [{ src: "/pwa/icon-192x192.png", sizes: "192x192" }],
        },
      ],
    },
    {
      headers: {
        "Content-Type": "application/manifest+json",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    }
  );
}
