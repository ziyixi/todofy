package todoist

// CreateTaskRequest represents the JSON payload for creating a new task.
// Fields are tagged with `json:"..."` to control serialization.
// The `omitempty` option ensures that nil or zero-value fields are not
// included in the JSON output, which is crucial for optional parameters.
type CreateTaskRequest struct {
	Content      string   `json:"content"`
	ProjectID    string   `json:"project_id,omitempty"`
	Description  string   `json:"description,omitempty"`
	SectionID    string   `json:"section_id,omitempty"`
	ParentID     string   `json:"parent_id,omitempty"`
	Order        int      `json:"order,omitempty"`
	Labels       []string `json:"labels,omitempty"`
	Priority     int      `json:"priority,omitempty"`
	DueString    string   `json:"due_string,omitempty"`
	DueDate      string   `json:"due_date,omitempty"`
	DueDatetime  string   `json:"due_datetime,omitempty"`
	DueLang      string   `json:"due_lang,omitempty"`
	AssigneeID   int      `json:"assignee_id,omitempty"`
	DeadlineDate string   `json:"deadline_date,omitempty"`
}

// Task represents a Todoist task object as returned by the API v1.
// This struct includes fields that are relevant after a task is created.
type Task struct {
	ID             string            `json:"id"`
	UserID         string            `json:"user_id"`
	ProjectID      string            `json:"project_id"`
	SectionID      string            `json:"section_id"`
	Content        string            `json:"content"`
	Description    string            `json:"description"`
	Checked        bool              `json:"checked"`
	IsDeleted      bool              `json:"is_deleted"`
	Labels         []string          `json:"labels"`
	ParentID       string            `json:"parent_id"`
	ChildOrder     int               `json:"child_order"`
	Priority       int               `json:"priority"`
	Due            map[string]any    `json:"due"`
	Deadline       map[string]string `json:"deadline"`
	Duration       map[string]any    `json:"duration"`
	AddedAt        string            `json:"added_at"`
	UpdatedAt      string            `json:"updated_at"`
	CompletedAt    string            `json:"completed_at"`
	AddedByUID     string            `json:"added_by_uid"`
	AssignedByUID  string            `json:"assigned_by_uid"`
	ResponsibleUID string            `json:"responsible_uid"`
	CompletedByUID string            `json:"completed_by_uid"`
	NoteCount      int               `json:"note_count"`
	DayOrder       int               `json:"day_order"`
	IsCollapsed    bool              `json:"is_collapsed"`
}
