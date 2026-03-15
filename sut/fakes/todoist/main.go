package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	admincontract "github.com/ziyixi/todofy/sut/contracts/admin"
	"github.com/ziyixi/todofy/todo/todoistapi"
)

var (
	port          = flag.Int("port", 8080, "Port for the fake Todoist service")
	expectedToken = flag.String("expected-token", "", "Expected bearer token")
)

const vendorBasePath = "/api/v1"

type updateTaskPayload struct {
	Content *string   `json:"content,omitempty"`
	Labels  *[]string `json:"labels,omitempty"`
}

type server struct {
	mu sync.Mutex

	tasks           map[string]todoistapi.Task
	taskOrder       []string
	labels          map[string]todoistapi.Label
	labelOrder      []string
	queuedResponses []admincontract.TodoistQueuedResponse
	calls           []admincontract.RecordedHTTPRequest
	nextTaskID      int
	nextLabelID     int
}

func main() {
	flag.Parse()

	srv := newServer()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/admin/reset", srv.handleAdminReset)
	mux.HandleFunc("/admin/seed", srv.handleAdminSeed)
	mux.HandleFunc("/admin/queue", srv.handleAdminQueue)
	mux.HandleFunc("/admin/state", srv.handleAdminState)
	mux.HandleFunc("/", srv.handleTodoist)

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("fake todoist listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("fake todoist server failed: %v", err)
	}
}

func newServer() *server {
	return &server{
		tasks:       make(map[string]todoistapi.Task),
		labels:      make(map[string]todoistapi.Label),
		nextTaskID:  1,
		nextLabelID: 1,
	}
}

func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) handleAdminReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	s.mu.Lock()
	s.resetLocked()
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, admincontract.ResetResponse{Status: "ok"})
}

func (s *server) handleAdminSeed(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req admincontract.SeedTodoistStateRequest
	if err := decodeJSON(r.Body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	s.mu.Lock()
	s.resetLocked()
	for _, task := range req.Tasks {
		s.storeTaskLocked(task)
	}
	for _, label := range req.Labels {
		s.storeLabelLocked(label)
	}
	s.queuedResponses = append([]admincontract.TodoistQueuedResponse(nil), req.QueuedResponses...)
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, admincontract.ResetResponse{Status: "ok"})
}

func (s *server) handleAdminQueue(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req admincontract.QueueTodoistResponsesRequest
	if err := decodeJSON(r.Body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	s.mu.Lock()
	s.queuedResponses = append(s.queuedResponses, req.Responses...)
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, admincontract.ResetResponse{Status: "ok"})
}

func (s *server) handleAdminState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	s.mu.Lock()
	resp := admincontract.TodoistStateResponse{
		Tasks:           s.snapshotTasksLocked(),
		Labels:          s.snapshotLabelsLocked(),
		QueuedResponses: append([]admincontract.TodoistQueuedResponse(nil), s.queuedResponses...),
		Calls:           append([]admincontract.RecordedHTTPRequest(nil), s.calls...),
	}
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, resp)
}

func (s *server) handleTodoist(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, vendorBasePath) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "failed to read request body"})
		return
	}
	s.recordCall(r, body)

	if *expectedToken != "" && strings.TrimSpace(r.Header.Get("Authorization")) != "Bearer "+*expectedToken {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}

	if queued, ok := s.popQueuedResponse(r.Method, r.URL.Path); ok {
		writeConfiguredResponse(w, queued.StatusCode, queued.Headers, queued.Body)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, vendorBasePath)
	switch {
	case r.Method == http.MethodPost && path == todoistapi.TasksPath:
		s.handleCreateTask(w, body)
	case r.Method == http.MethodGet && path == todoistapi.TasksPath:
		s.handleListTasks(w)
	case strings.HasPrefix(path, todoistapi.TasksPath+"/"):
		s.handleTaskByID(w, r.Method, strings.TrimPrefix(path, todoistapi.TasksPath+"/"), body)
	case r.Method == http.MethodGet && path == todoistapi.LabelsPath:
		s.handleListLabels(w)
	case r.Method == http.MethodPost && path == todoistapi.LabelsPath:
		s.handleCreateLabel(w, body)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unsupported path"})
	}
}

func (s *server) handleCreateTask(w http.ResponseWriter, body []byte) {
	var req todoistapi.CreateTaskRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid create task request"})
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	task := todoistapi.Task{
		ProjectID:   req.ProjectID,
		Content:     req.Content,
		Description: req.Description,
		Labels:      append([]string(nil), req.Labels...),
		AddedAt:     now,
		UpdatedAt:   now,
		Priority:    req.Priority,
		ParentID:    req.ParentID,
		SectionID:   req.SectionID,
	}

	s.mu.Lock()
	task = s.storeTaskLocked(task)
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, task)
}

func (s *server) handleListTasks(w http.ResponseWriter) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tasks := make([]todoistapi.Task, 0, len(s.taskOrder))
	for _, id := range s.taskOrder {
		task := s.tasks[id]
		if task.IsDeleted || task.Checked || task.IsCompleted || strings.TrimSpace(task.CompletedAt) != "" {
			continue
		}
		tasks = append(tasks, cloneTask(task))
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (s *server) handleTaskByID(w http.ResponseWriter, method string, taskID string, body []byte) {
	s.mu.Lock()
	task, exists := s.tasks[taskID]
	s.mu.Unlock()
	if !exists {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}

	switch method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, task)
	case http.MethodPost:
		var req updateTaskPayload
		if err := json.Unmarshal(body, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid update task request"})
			return
		}

		if req.Content != nil {
			task.Content = strings.TrimSpace(*req.Content)
		}
		if req.Labels != nil {
			task.Labels = append([]string(nil), (*req.Labels)...)
		}
		task.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

		s.mu.Lock()
		s.tasks[taskID] = cloneTask(task)
		s.mu.Unlock()

		writeJSON(w, http.StatusOK, task)
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}

func (s *server) handleListLabels(w http.ResponseWriter) {
	s.mu.Lock()
	labels := s.snapshotLabelsLocked()
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, labels)
}

func (s *server) handleCreateLabel(w http.ResponseWriter, body []byte) {
	var req todoistapi.CreateLabelRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid create label request"})
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "label name is required"})
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	for _, id := range s.labelOrder {
		label := s.labels[id]
		if label.Name == name {
			writeJSON(w, http.StatusOK, cloneLabel(label))
			return
		}
	}

	label := s.storeLabelLocked(todoistapi.Label{Name: name})

	writeJSON(w, http.StatusOK, label)
}

func (s *server) popQueuedResponse(method string, path string) (admincontract.TodoistQueuedResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, resp := range s.queuedResponses {
		if !strings.EqualFold(resp.Method, method) || resp.Path != path {
			continue
		}
		s.queuedResponses = append(s.queuedResponses[:i], s.queuedResponses[i+1:]...)
		return resp, true
	}
	return admincontract.TodoistQueuedResponse{}, false
}

func (s *server) recordCall(r *http.Request, body []byte) {
	call := admincontract.RecordedHTTPRequest{
		Method:  r.Method,
		Path:    r.URL.Path,
		Query:   r.URL.RawQuery,
		Headers: cloneHeaders(r.Header),
		Body:    string(body),
	}

	s.mu.Lock()
	s.calls = append(s.calls, call)
	s.mu.Unlock()
}

func (s *server) resetLocked() {
	s.tasks = make(map[string]todoistapi.Task)
	s.taskOrder = nil
	s.labels = make(map[string]todoistapi.Label)
	s.labelOrder = nil
	s.queuedResponses = nil
	s.calls = nil
	s.nextTaskID = 1
	s.nextLabelID = 1
}

func (s *server) storeTaskLocked(task todoistapi.Task) todoistapi.Task {
	task = cloneTask(task)
	if strings.TrimSpace(task.ID) == "" {
		task.ID = s.nextTaskIDLocked()
	}
	if _, exists := s.tasks[task.ID]; !exists {
		s.taskOrder = append(s.taskOrder, task.ID)
	}
	s.tasks[task.ID] = task
	s.bumpTaskCounterLocked(task.ID)
	return task
}

func (s *server) storeLabelLocked(label todoistapi.Label) todoistapi.Label {
	label = cloneLabel(label)
	if strings.TrimSpace(label.ID) == "" {
		label.ID = s.nextLabelIDLocked()
	}
	if _, exists := s.labels[label.ID]; !exists {
		s.labelOrder = append(s.labelOrder, label.ID)
	}
	s.labels[label.ID] = label
	s.bumpLabelCounterLocked(label.ID)
	return label
}

func (s *server) snapshotTasksLocked() []todoistapi.Task {
	tasks := make([]todoistapi.Task, 0, len(s.taskOrder))
	for _, id := range s.taskOrder {
		tasks = append(tasks, cloneTask(s.tasks[id]))
	}
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].ID < tasks[j].ID
	})
	return tasks
}

func (s *server) snapshotLabelsLocked() []todoistapi.Label {
	labels := make([]todoistapi.Label, 0, len(s.labelOrder))
	for _, id := range s.labelOrder {
		labels = append(labels, cloneLabel(s.labels[id]))
	}
	sort.Slice(labels, func(i, j int) bool {
		if labels[i].Name != labels[j].Name {
			return labels[i].Name < labels[j].Name
		}
		return labels[i].ID < labels[j].ID
	})
	return labels
}

func (s *server) nextTaskIDLocked() string {
	id := strconv.Itoa(s.nextTaskID)
	s.nextTaskID++
	return id
}

func (s *server) nextLabelIDLocked() string {
	id := strconv.Itoa(s.nextLabelID)
	s.nextLabelID++
	return id
}

func (s *server) bumpTaskCounterLocked(id string) {
	if numericID, err := strconv.Atoi(id); err == nil && numericID >= s.nextTaskID {
		s.nextTaskID = numericID + 1
	}
}

func (s *server) bumpLabelCounterLocked(id string) {
	if numericID, err := strconv.Atoi(id); err == nil && numericID >= s.nextLabelID {
		s.nextLabelID = numericID + 1
	}
}

func cloneTask(task todoistapi.Task) todoistapi.Task {
	task.Labels = append([]string(nil), task.Labels...)
	if task.Due != nil {
		due := make(map[string]any, len(task.Due))
		for key, value := range task.Due {
			due[key] = value
		}
		task.Due = due
	}
	if task.Deadline != nil {
		deadline := make(map[string]string, len(task.Deadline))
		for key, value := range task.Deadline {
			deadline[key] = value
		}
		task.Deadline = deadline
	}
	if task.Duration != nil {
		duration := make(map[string]any, len(task.Duration))
		for key, value := range task.Duration {
			duration[key] = value
		}
		task.Duration = duration
	}
	return task
}

func cloneLabel(label todoistapi.Label) todoistapi.Label {
	return label
}

func writeConfiguredResponse(w http.ResponseWriter, statusCode int, headers map[string]string, body string) {
	if statusCode == 0 {
		statusCode = http.StatusOK
	}
	for key, value := range headers {
		w.Header().Set(key, value)
	}
	if body == "" {
		w.WriteHeader(statusCode)
		return
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(statusCode)
	_, _ = w.Write([]byte(body))
}

func writeJSON(w http.ResponseWriter, statusCode int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if value == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("failed to encode response: %v", err)
	}
}

func decodeJSON(r io.Reader, out any) error {
	decoder := json.NewDecoder(r)
	return decoder.Decode(out)
}

func cloneHeaders(headers http.Header) map[string][]string {
	out := make(map[string][]string, len(headers))
	for key, values := range headers {
		out[key] = append([]string(nil), values...)
	}
	return out
}
