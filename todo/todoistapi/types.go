package todoistapi

const (
	DefaultBaseURL = "https://api.todoist.com/api/v1"
	TasksPath      = "/tasks"
	LabelsPath     = "/labels"
)

// CreateTaskRequest represents the JSON payload for creating a new task.
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

// UpdateTaskRequest represents the partial payload for updating an existing task.
type UpdateTaskRequest struct {
	Content string   `json:"content,omitempty"`
	Labels  []string `json:"labels,omitempty"`
}

// Label represents a Todoist label.
type Label struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// CreateLabelRequest represents the JSON payload for creating a label.
type CreateLabelRequest struct {
	Name string `json:"name"`
}

// EnsureLabelsResult reports ensure-label outcomes.
type EnsureLabelsResult struct {
	ExistingLabels []string
	CreatedLabels  []string
	Failures       map[string]string
}

// Task represents a Todoist task object as returned by the API.
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
	IsCompleted    bool              `json:"is_completed"`
	AddedByUID     string            `json:"added_by_uid"`
	AssignedByUID  string            `json:"assigned_by_uid"`
	ResponsibleUID string            `json:"responsible_uid"`
	CompletedByUID string            `json:"completed_by_uid"`
	NoteCount      int               `json:"note_count"`
	DayOrder       int               `json:"day_order"`
	IsCollapsed    bool              `json:"is_collapsed"`
}
