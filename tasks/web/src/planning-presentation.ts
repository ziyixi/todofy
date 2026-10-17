import type { Plan } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";

export function planningPresentation(plan?: Plan) {
  // A failed or unconfirmed native read must not hide organization data.
  const bindings = plan?.enabled ? plan.labels : [];
  return {
    roles: new Map(bindings.map((binding) => [binding.id, binding.role])),
    hiddenFilters: new Set(plan?.enabled ? plan.hiddenFilterIds : []),
  };
}
const titles: Record<string, string> = {
  office: "Work",
  home: "Personal",
  quarter: "This quarter",
  candiate: "This month",
  focus: "This week",
  committed: "Committed",
};
export function planningChips(
  ids: string[],
  roles: ReadonlyMap<string, string>,
): string[] {
  return ids.flatMap((id) => {
    const title = titles[roles.get(id) || ""];
    return title ? [title] : [];
  });
}
