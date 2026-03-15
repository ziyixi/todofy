package admin

import "github.com/ziyixi/todofy/todo/todoistapi"

// TodoistQueuedResponse configures one queued fake Todoist response.
type TodoistQueuedResponse struct {
	Method     string            `json:"method"`
	Path       string            `json:"path"`
	StatusCode int               `json:"status_code"`
	DelayMs    int               `json:"delay_ms,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Body       string            `json:"body,omitempty"`
}

// SeedTodoistStateRequest replaces fake Todoist state.
type SeedTodoistStateRequest struct {
	Tasks           []todoistapi.Task       `json:"tasks,omitempty"`
	Labels          []todoistapi.Label      `json:"labels,omitempty"`
	QueuedResponses []TodoistQueuedResponse `json:"queued_responses,omitempty"`
}

// QueueTodoistResponsesRequest appends queued fake Todoist responses.
type QueueTodoistResponsesRequest struct {
	Responses []TodoistQueuedResponse `json:"responses,omitempty"`
}

// TodoistStateResponse returns fake Todoist state for assertions.
type TodoistStateResponse struct {
	Tasks           []todoistapi.Task       `json:"tasks,omitempty"`
	Labels          []todoistapi.Label      `json:"labels,omitempty"`
	QueuedResponses []TodoistQueuedResponse `json:"queued_responses,omitempty"`
	Calls           []RecordedHTTPRequest   `json:"calls,omitempty"`
}
