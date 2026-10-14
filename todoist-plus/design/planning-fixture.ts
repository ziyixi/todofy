import type { Outcome, PlanningData } from "./planning-model";

function outcome(
  id: string,
  title: string,
  area: Outcome["area"],
  lane: Outcome["lane"],
  color: string,
  titles: string[],
  extra: Partial<Outcome> = {},
): Outcome {
  return {
    id,
    title,
    area,
    lane,
    color,
    priority: 1,
    context: area === "work" ? "Work · Projects" : "Personal · Life",
    steps: titles.map((title, index) => ({
      id: `${id}-${index + 1}`,
      title,
      minutes: [30, 45, 60][index % 3]!,
    })),
    ...extra,
  };
}

export function planningFixture(): PlanningData {
  return {
    weeklyGoals: {
      work: "Make the next release ready to share",
      personal: "Have a calmer place to work at home",
    },
    outcomes: [
      outcome(
        "website",
        "Ship the website refresh",
        "work",
        "committed",
        "#6387a3",
        [
          "Write the introduction",
          "Check the mobile layout",
          "Publish the final changes",
        ],
        { priority: 4, deadline: "2026-10-23" },
      ),
      outcome(
        "research",
        "Prepare the research check-in",
        "work",
        "committed",
        "#9b7eb0",
        ["Outline three questions", "Pick two useful examples"],
        { mustStart: true, priority: 3, deadline: "2026-10-16" },
      ),
      outcome(
        "notes",
        "Make experiment notes useful",
        "work",
        "committed",
        "#6b928c",
        ["Group this week's results", "Write a short comparison"],
        { priority: 2 },
      ),
      outcome(
        "cleanup",
        "Finish the small release cleanup",
        "work",
        "committed",
        "#a98369",
        ["Remove the unused branch", "Check the release notes"],
      ),
      outcome(
        "demo",
        "Get the demo ready to share",
        "work",
        "committed",
        "#829968",
        ["Choose a simple example", "Record a two-minute walkthrough"],
      ),
      outcome(
        "desk",
        "Make the home desk comfortable",
        "personal",
        "committed",
        "#aa8b63",
        ["Measure the space for a lamp", "Compare two desk lamps"],
      ),
      outcome(
        "trip",
        "Plan a relaxed weekend away",
        "personal",
        "committed",
        "#7794aa",
        ["Choose a short trail", "Check the train times"],
      ),
      outcome(
        "health",
        "Book the annual check-up",
        "personal",
        "committed",
        "#978caa",
        ["Find a suitable appointment"],
      ),
      outcome("charts", "Try the charting idea", "work", "week", "#7d9a91", [
        "Build one small chart",
        "Decide whether to keep it",
      ]),
      outcome(
        "reading",
        "Collect references for the next idea",
        "work",
        "month",
        "#8b91b2",
        ["Read the overview", "Save three useful references"],
      ),
      outcome(
        "photos",
        "Organize the holiday photos",
        "personal",
        "month",
        "#b4917d",
        ["Pick the photos worth keeping"],
      ),
      outcome(
        "course",
        "Explore the next research direction",
        "work",
        "quarter",
        "#7d96ad",
        ["List the open questions", "Choose a small experiment"],
      ),
      outcome(
        "home",
        "Simplify the home storage",
        "personal",
        "quarter",
        "#9a996e",
        ["Choose one cupboard to start with"],
      ),
    ],
    queues: {
      "2026-10-12": ["cleanup-1"],
      "2026-10-13": ["website-1", "research-1", "desk-1"],
      "2026-10-14": ["notes-1", "website-2"],
      "2026-10-15": ["demo-1"],
      "2026-10-17": ["trip-1"],
    },
  };
}
