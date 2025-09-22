package todoist

import "time"

// CreateTaskRequest represents the JSON payload for creating a new task.
// Fields are tagged with `json:"..."` to control serialization.
// The `omitempty` option ensures that nil or zero-value fields are not
// included in the JSON output, which is crucial for optional parameters.
type CreateTaskRequest struct {
	Content     string `json:"content"`
	ProjectID   string `json:"project_id,omitempty"`
	Description string `json:"description,omitempty"`
	SectionID   string `json:"section_id,omitempty"`
	ParentID    string `json:"parent_id,omitempty"`
	Order       int    `json:"order,omitempty"`
	LabelIDs    string `json:"label_ids,omitempty"`
	Priority    int    `json:"priority,omitempty"`
	DueString   string `json:"due_string,omitempty"`
	DueDate     string `json:"due_date,omitempty"`
	DueDatetime string `json:"due_datetime,omitempty"`
	DueLang     string `json:"due_lang,omitempty"`
	AssigneeID  string `json:"assignee_id,omitempty"`
}

// Task represents a Todoist task object as returned by the API.
// This struct includes fields that are relevant after a task is created.
type Task struct {
	ID          string `json:"id"`
	ProjectID   string `json:"project_id"`
	SectionID   string `json:"section_id"`
	Content     string `json:"content"`
	Description string `json:"description"`
	IsCompleted bool   `json:"is_completed"`
	LabelIDs    string `json:"label_ids"`
	ParentID    string `json:"parent_id"`
	Order       int    `json:"order"`
	Priority    int    `json:"priority"`
	Due         *struct {
		Date        string `json:"date"`
		IsRecurring bool   `json:"is_recurring"`
		Datetime    string `json:"datetime"`
		String      string `json:"string"`
		Timezone    string `json:"timezone"`
	} `json:"due"`
	URL          string    `json:"url"`
	CommentCount int       `json:"comment_count"`
	CreatedAt    time.Time `json:"created_at"`
	CreatorID    string    `json:"creator_id"`
	AssigneeID   string    `json:"assignee_id"`
	AssignerID   string    `json:"assigner_id"`
}
