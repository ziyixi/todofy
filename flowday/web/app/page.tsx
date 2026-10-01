import { AppShell } from "@/features/layout/components/app-shell";

export default function Home() {
  return <AppShell e2eEnabled={process.env.NEXT_PUBLIC_FLOWDAY_E2E === "1"} />;
}
