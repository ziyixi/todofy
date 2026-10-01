export interface TaskCreateBody {
  title?: string;
  priority?: number;
  dueDate?: string;
  estimatedMins?: number | string | null;
  labels?: string[];
  description?: string;
}

export interface TaskPatchBody {
  taskId?: string;
  estimatedMins?: number | string | null;
  title?: string;
}

export interface TaskDeleteBody {
  taskId?: string;
}
