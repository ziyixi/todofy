import type { APIRequestContext, APIResponse } from "@playwright/test";

interface Resource {
  id: string;
  name: string;
  title: string;
  etag: string;
}
interface GoalCatalog {
  year: number;
  today: string;
}

/** Only synthetic definitions, evidence and Tasks; reusable with a separate ephemeral preview origin. */
export async function seedGoalsPage(
  request: APIRequestContext,
  origin = "http://127.0.0.1:8798",
) {
  const read = (path: string) => request.get(`${origin}/api/tasks/v1/${path}`);
  async function checked(response: APIResponse): Promise<Resource> {
    if (response.status() !== 200)
      throw new Error(`Synthetic Goals seed failed at ${new URL(response.url()).pathname}: HTTP ${response.status()} ${await response.text()}`);
    return response.json() as Promise<Resource>;
  }
  const { token } = await (
    await request.get(`${origin}/api/tasks/csrf`)
  ).json();
  const headers = { "x-csrf-token": token as string, origin };
  const create = async (kind: string, data: Record<string, unknown>) =>
    checked(
      await request.post(
        `${origin}/api/tasks/v1/${kind}?request_id=${crypto.randomUUID()}`,
        { headers, data },
      ),
    );
  const catalog = (await (await read("goalCatalog")).json()) as GoalCatalog;
  const year = catalog.year;
  const titles = [
    "示例 · 身体状态",
    "示例 · 技术练习",
    "示例 · 稳定节奏",
    "示例 · 开放探索",
  ];
  const objectives: Resource[] = [];
  const keyResults: Resource[] = [];
  for (const [index, title] of titles.entries()) {
    const objective = await create("objectives", {
      title,
      year,
      sort_order: index,
    });
    objectives.push(objective);
    for (let position = 0; position < 3; position++) {
      const selected = index === 1 && position === 0;
      const exploration = index === 3;
      const kind = exploration
        ? "exploration"
        : position === 1
          ? "routine"
          : "outcome";
      const result = await create("keyResults", {
        objective_id: objective.id,
        title: selected
          ? "KR 2.1 · 完成一个可运行的示例项目"
          : `示例 ${index + 1}.${position + 1} · ${exploration ? "尝试一个感兴趣的活动" : "建立可持续的小练习"}`,
        kind,
        floor_text: selected ? "每周 4 小时练习" : "",
        target_text: selected ? "完成 1–2 个示例项目或复现笔记" : "",
        notes: exploration
          ? "开放尝试，记录感受与下一步，不设置量化指标。"
          : "",
        sort_order: position,
        ...(selected
          ? {
              focus_start_month: `${year}-10`,
              source_url: "https://example.org/synthetic-okr",
              focus_end_month: `${year}-12`,
              focus_text: "把一个小型技术实验做成可复现的示例",
              milestones: [
                { title: "示例实验范围已确定", completed: true },
                { title: "基线与对比结果可复现" },
                { title: "示例演示与笔记可分享" },
              ],
            }
          : {}),
      });
      keyResults.push(result);
    }
  }
  const selected = keyResults[3]!;
  const parent = await create("tasks", {
    title: "跑通示例最小基线",
    key_result_id: selected.id,
    stage: "committed",
    area: "work",
  });
  const stepTitles = ["准备公开测试样例", "实现基线并运行", "记录示例复现步骤"];
  const steps: Resource[] = [];
  for (const [index, title] of stepTitles.entries()) {
    steps.push(
      await create("tasks", {
        title,
        parent_id: parent.id,
        kind: "step",
        duration_minutes: [15, 60, 30][index],
        sort_order: index,
      }),
    );
  }
  await checked(
    await request.post(
      `${origin}/api/tasks/v1/tasks/${steps[0]!.id}:complete`,
      {
        headers,
        data: { request_id: crypto.randomUUID(), etag: steps[0]!.etag },
      },
    ),
  );
  const otherTask = await create("tasks", {
    title: "比较示例结果并确定下一步",
    key_result_id: selected.id,
    stage: "weekly",
    area: "work",
  });
  const progress = await create("goalProgress", {
    key_result_id: selected.id,
    note: "示例实验的范围已确定，开始准备最小基线。",
    evidence_url: "https://example.org/synthetic-baseline",
  });
  const plan = (await (await read("plan")).json()) as {
    week_start: string;
    weekly_bets?: { week_start: string; area: string; etag: string }[];
  };
  const current = plan.weekly_bets?.find(
    (bet) => bet.week_start === plan.week_start && bet.area === "work",
  );
  await checked(
    await request.patch(
      `${origin}/api/tasks/v1/weeklyBets/${plan.week_start}-work?update_mask=text,key_result_id&etag=${encodeURIComponent(current?.etag ?? "")}`,
      {
        headers,
        data: {
          text: "验证一个可继续的示例实验方向",
          key_result_id: selected.id,
        },
      },
    ),
  );
  return {
    year,
    today: catalog.today,
    weekStart: plan.week_start,
    objectives,
    keyResults,
    selected,
    exploration: keyResults[9]!,
    parent,
    steps,
    otherTask,
    progress,
  };
}
