export * from "@ziyixi/planning-ui/domain";

export function todoistTaskUrl(id: string): string {
  return `https://app.todoist.com/app/task/${encodeURIComponent(id)}`;
}

export function todoistProjectUrl(id: string): string {
  return `https://app.todoist.com/app/project/${encodeURIComponent(id)}`;
}
