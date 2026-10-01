export type FlowMutationAction =
  | {
      action: "setFlow";
      date: string;
      taskIds: string[];
    }
  | {
      action: "addCompleted" | "removeCompleted";
      date: string;
      taskId: string;
    }
  | {
      action: "rollover";
      date: string;
      fromDate: string;
      toDate: string;
    }
  | {
      action: "rolloverSelected";
      date: string;
      fromDate: string;
      toDate: string;
      taskIds: string[];
    };

export interface FlowStateResponse {
  flows: Record<string, string[]>;
  completedTasks: Record<string, string[]>;
}

export interface FlowTaskNoteRow {
  taskId: string;
  flowDate: string;
  content: string;
}
