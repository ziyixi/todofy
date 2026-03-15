package todoist

import "github.com/ziyixi/todofy/todo/todoistapi"

const (
	defaultBaseURL    = todoistapi.DefaultBaseURL
	todoistTasksPath  = todoistapi.TasksPath
	todoistLabelsPath = todoistapi.LabelsPath
)

type CreateTaskRequest = todoistapi.CreateTaskRequest
type UpdateTaskRequest = todoistapi.UpdateTaskRequest
type Label = todoistapi.Label
type createLabelRequest = todoistapi.CreateLabelRequest
type EnsureLabelsResult = todoistapi.EnsureLabelsResult
type Task = todoistapi.Task
