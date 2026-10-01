export interface DailyTaskData {
  id: string;
  title: string;
  projectName: string | null;
  projectColor: string | null;
  estimatedMins: number | null;
  loggedMins: number;
  completed: boolean;
}

export interface DailyAnalyticsData {
  date: string;
  tasksPlanned: number;
  tasksCompleted: number;
  totalEstimatedMins: number;
  totalLoggedMins: number;
  dayCapacityMins: number;
  tasks: DailyTaskData[];
  hourlyMins: number[];
}

export interface WeeklyDayData {
  date: string;
  dayOfWeek: string;
  tasksPlanned: number;
  tasksCompleted: number;
  loggedMins: number;
}

export interface WeeklyAnalyticsData {
  weekStart: string;
  weekEnd: string;
  days: WeeklyDayData[];
  byProject: {
    projectName: string;
    projectColor: string | null;
    loggedMins: number;
    tasksCompleted: number;
  }[];
  stuckTasks: {
    id: string;
    title: string;
    daysAppeared: number;
    dates: string[];
  }[];
  estimationAccuracy: {
    id: string;
    title: string;
    estimatedMins: number;
    actualMins: number;
  }[];
  heatmap: number[][];
  totals: {
    tasksCompleted: number;
    totalLoggedMins: number;
    avgTasksPerDay: number;
    overallAccuracy: number | null;
  };
}

export interface WorkPatternStatsData {
  weekCount: number[][];
  totalMins: number[][];
  totalWeeks: number;
}
