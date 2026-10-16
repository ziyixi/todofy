import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Options } from "../src/Options";

const replies = vi.hoisted(() => ({ pageStatus: null as unknown }));
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: vi.fn(async (message: { kind: string }) =>
        message.kind === "pageStatus"
          ? { ok: true, value: replies.pageStatus }
          : { ok: true, value: { connected: true, apiOrigin: "" } },
      ),
    },
  },
}));
afterEach(cleanup);

it("shows the latest Todoist page check in one line", async () => {
  replies.pageStatus = { language: "zh", off: {} };
  render(<Options />);
  expect(await screen.findByText("Todoist 页面检测：全部正常")).toBeTruthy();
  cleanup();
  replies.pageStatus = { language: "en", off: { views: "content" } };
  render(<Options />);
  expect(
    await screen.findByText(
      "Todoist page check: Plan and Focus are off (the main content area was not found)",
    ),
  ).toBeTruthy();
  cleanup();
  replies.pageStatus = null;
  render(<Options />);
  expect(
    await screen.findByText("Todoist page check: open Todoist to run it"),
  ).toBeTruthy();
});
