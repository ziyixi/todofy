package main

import (
	"context"
	"errors"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/dependency"
	"github.com/ziyixi/todofy/todo/internal/todoist"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type dependencyServer struct {
	pb.UnimplementedDependencyServiceServer

	// newTodoistClient is injectable for tests.
	newTodoistClient todoistOperationalClientFactory
	// metadataExcludedProjectIDs are skipped during missing-key bootstrap.
	metadataExcludedProjectIDs map[string]struct{}
	// gracePeriod suppresses label writes for very recently updated tasks.
	gracePeriod time.Duration
	// reconcileInterval controls periodic background reconcile cadence.
	reconcileInterval time.Duration
	// webhookDebounce coalesces bursts of webhook dirty signals.
	webhookDebounce time.Duration
	// enableBackgroundReconcile toggles the scheduler loop.
	enableBackgroundReconcile bool
	// reconcileTimeout bounds the lifetime of one full reconcile/bootstrap run.
	reconcileTimeout time.Duration
	// readTimeout bounds one upstream read/precondition operation.
	readTimeout time.Duration
	// writeTimeout bounds one upstream write operation.
	writeTimeout time.Duration

	// dirtySignal is a single-slot queue to avoid unbounded webhook fan-in.
	dirtySignal chan struct{}

	// reconcileMu prevents overlapping reconcile runs.
	reconcileMu sync.Mutex
}

func newDependencyServer() *dependencyServer {
	return &dependencyServer{
		newTodoistClient:           defaultTodoistOperationalClientFactory,
		metadataExcludedProjectIDs: metadataBootstrapExcludedProjectSet(*dependencyBootstrapExcludedProjectIDs),
		gracePeriod:                *dependencyGracePeriod,
		reconcileInterval:          *dependencyReconcileInterval,
		webhookDebounce:            *dependencyWebhookDebounce,
		enableBackgroundReconcile:  *dependencyEnableScheduler,
		reconcileTimeout:           *dependencyReconcileTimeout,
		readTimeout:                *dependencyReadTimeout,
		writeTimeout:               *dependencyWriteTimeout,
		dirtySignal:                make(chan struct{}, 1),
	}
}

func (s *dependencyServer) getClient() (todoistOperationalClient, error) {
	if err := validateTodoistFlags(); err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "%v", err)
	}
	factory := s.newTodoistClient
	if factory == nil {
		factory = defaultTodoistOperationalClientFactory
	}
	return factory(*todoistAPIKey), nil
}

// ReconcileGraph recomputes dependency status and applies reserved label updates.
func (s *dependencyServer) ReconcileGraph(
	ctx context.Context,
	_ *pb.ReconcileDependencyGraphRequest,
) (*pb.ReconcileDependencyGraphResponse, error) {
	runCtx, cancel := boundedContext(ctx, s.reconcileTimeout)
	defer cancel()

	report, updatedCount, writeFailures, err := s.reconcile(runCtx)
	if err != nil {
		return nil, err
	}

	return &pb.ReconcileDependencyGraphResponse{
		TaskCount:         int32(report.TaskCount),
		UpdatedTaskCount:  int32(updatedCount),
		Issues:            report.Issues,
		TaskStatuses:      report.TaskStatuses,
		PartialSuccess:    len(writeFailures) > 0,
		FailedUpdateCount: int32(len(writeFailures)),
		WriteFailures:     writeFailures,
	}, nil
}

// AnalyzeGraph computes dependency status and issues without writing Todoist changes.
func (s *dependencyServer) AnalyzeGraph(
	ctx context.Context,
	_ *pb.AnalyzeDependencyGraphRequest,
) (*pb.AnalyzeDependencyGraphResponse, error) {
	readCtx, cancel := boundedContext(ctx, s.readTimeout)
	defer cancel()

	report, err := s.analyze(readCtx)
	if err != nil {
		return nil, err
	}
	return &pb.AnalyzeDependencyGraphResponse{
		TaskCount:    int32(report.TaskCount),
		Issues:       report.Issues,
		TaskStatuses: report.TaskStatuses,
	}, nil
}

// BootstrapMissingTaskKeys generates metadata task keys for active tasks that do not have one.
func (s *dependencyServer) BootstrapMissingTaskKeys(
	ctx context.Context,
	req *pb.BootstrapMissingTaskKeysRequest,
) (*pb.BootstrapMissingTaskKeysResponse, error) {
	runCtx, cancel := boundedContext(ctx, s.reconcileTimeout)
	defer cancel()

	client, err := s.getClient()
	if err != nil {
		return nil, err
	}

	listCtx, cancelList := boundedContext(runCtx, s.readTimeout)
	tasks, err := client.ListActiveTasks(listCtx)
	cancelList()
	if err != nil {
		return nil, dependencyExternalStatusError("list active Todoist tasks", err)
	}

	usedKeys := make(map[string]struct{}, len(tasks))
	metadataByTask := make(map[string]dependency.ParsedMetadata, len(tasks))
	for _, task := range tasks {
		if task == nil {
			continue
		}
		parsed := dependency.ParseTaskMetadata(task.Content)
		metadataByTask[task.ID] = parsed
		if parsed.Valid && parsed.TaskKey != "" {
			usedKeys[parsed.TaskKey] = struct{}{}
		}
	}

	generated := make([]*pb.GeneratedTaskKey, 0)
	writeFailures := make([]*pb.DependencyWriteFailure, 0)
	for _, task := range tasks {
		if task == nil {
			continue
		}
		if s.isMetadataBootstrapExcludedProject(task.ProjectID) {
			continue
		}
		parsed := metadataByTask[task.ID]
		if !parsed.Valid || parsed.TaskKey != "" {
			continue
		}

		newKey := dependency.GenerateTaskKey(parsed.DisplayTitle, usedKeys)
		newContent, buildErr := dependency.BuildContentWithTaskKey(task.Content, newKey)
		if buildErr != nil {
			return nil, status.Errorf(codes.Internal, "failed to build metadata for task %s: %v", task.ID, buildErr)
		}

		if !req.GetDryRun() {
			writeCtx, cancelWrite := boundedContext(runCtx, s.writeTimeout)
			_, updateErr := client.UpdateTaskContent(writeCtx, task.ID, newContent)
			cancelWrite()
			if updateErr != nil {
				writeFailures = append(writeFailures, newDependencyWriteFailure(
					task.ID,
					newKey,
					dependencyWriteOperationUpdateContent,
					dependencyOperationMessage("update Todoist task content", updateErr),
				))
				continue
			}
		}

		generated = append(generated, &pb.GeneratedTaskKey{
			TodoistTaskId: task.ID,
			TaskKey:       newKey,
		})
	}

	return &pb.BootstrapMissingTaskKeysResponse{
		GeneratedCount:    int32(len(generated)),
		GeneratedTaskKeys: generated,
		PartialSuccess:    len(writeFailures) > 0,
		FailedUpdateCount: int32(len(writeFailures)),
		WriteFailures:     writeFailures,
	}, nil
}

// GetTaskStatus returns dependency status for a specific task key or Todoist task id.
func (s *dependencyServer) GetTaskStatus(
	ctx context.Context,
	req *pb.GetTaskDependencyStatusRequest,
) (*pb.GetTaskDependencyStatusResponse, error) {
	taskKey := strings.TrimSpace(req.GetTaskKey())
	taskID := strings.TrimSpace(req.GetTodoistTaskId())
	if taskKey == "" && taskID == "" {
		return nil, status.Error(codes.InvalidArgument, "task_key or todoist_task_id is required")
	}

	readCtx, cancel := boundedContext(ctx, s.readTimeout)
	defer cancel()

	report, err := s.analyze(readCtx)
	if err != nil {
		return nil, err
	}

	for _, statusItem := range report.TaskStatuses {
		if statusItem == nil {
			continue
		}
		if taskKey != "" && statusItem.GetTaskKey() != taskKey {
			continue
		}
		if taskID != "" && statusItem.GetTodoistTaskId() != taskID {
			continue
		}
		return &pb.GetTaskDependencyStatusResponse{
			Status: statusItem,
		}, nil
	}

	return nil, status.Error(codes.NotFound, "task status not found")
}

// ListDependencyIssues returns dependency issues filtered by issue type and task key.
func (s *dependencyServer) ListDependencyIssues(
	ctx context.Context,
	req *pb.ListDependencyIssuesRequest,
) (*pb.ListDependencyIssuesResponse, error) {
	readCtx, cancel := boundedContext(ctx, s.readTimeout)
	defer cancel()

	report, err := s.analyze(readCtx)
	if err != nil {
		return nil, err
	}

	taskKey := strings.TrimSpace(req.GetTaskKey())
	filterType := req.GetType()
	filtered := make([]*pb.DependencyIssue, 0, len(report.Issues))
	for _, issue := range report.Issues {
		if issue == nil {
			continue
		}
		if filterType != pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_UNSPECIFIED && issue.GetType() != filterType {
			continue
		}
		if taskKey != "" && issue.GetTaskKey() != taskKey {
			continue
		}
		filtered = append(filtered, issue)
	}

	return &pb.ListDependencyIssuesResponse{Issues: filtered}, nil
}

// MarkGraphDirty records a dirty signal so background reconcile can refresh graph state.
func (s *dependencyServer) MarkGraphDirty(
	_ context.Context,
	_ *pb.MarkDependencyGraphDirtyRequest,
) (*pb.MarkDependencyGraphDirtyResponse, error) {
	select {
	case s.dirtySignal <- struct{}{}:
	default:
	}
	return &pb.MarkDependencyGraphDirtyResponse{Accepted: true}, nil
}

// StartBackgroundReconcile starts the scheduler loop when background reconcile is enabled.
func (s *dependencyServer) StartBackgroundReconcile(ctx context.Context) {
	if !s.enableBackgroundReconcile {
		return
	}

	go s.backgroundLoop(ctx)
}

func (s *dependencyServer) backgroundLoop(ctx context.Context) {
	var ticker *time.Ticker
	var tickerC <-chan time.Time
	if s.reconcileInterval > 0 {
		ticker = time.NewTicker(s.reconcileInterval)
		tickerC = ticker.C
		defer ticker.Stop()
	}

	var debounceTimer *time.Timer
	var debounceC <-chan time.Time

	for {
		select {
		case <-ctx.Done():
			if debounceTimer != nil {
				debounceTimer.Stop()
			}
			return
		case <-tickerC:
			s.backgroundReconcile()
		case <-s.dirtySignal:
			if s.webhookDebounce <= 0 {
				// Immediate mode for tests or when debounce is explicitly disabled.
				s.backgroundReconcile()
				continue
			}
			if debounceTimer == nil {
				debounceTimer = time.NewTimer(s.webhookDebounce)
			} else {
				if !debounceTimer.Stop() {
					select {
					case <-debounceTimer.C:
					default:
					}
				}
				debounceTimer.Reset(s.webhookDebounce)
			}
			debounceC = debounceTimer.C
		case <-debounceC:
			s.backgroundReconcile()
			debounceC = nil
		}
	}
}

func (s *dependencyServer) backgroundReconcile() {
	ctx, cancel := boundedContext(context.Background(), s.reconcileTimeout)
	defer cancel()
	_, updatedCount, writeFailures, err := s.reconcile(ctx)
	if err != nil {
		log.Warningf("dependency background reconcile failed: %v", err)
		return
	}
	if len(writeFailures) > 0 {
		log.Warningf(
			"dependency background reconcile completed with %d successful updates and %d failed writes",
			updatedCount,
			len(writeFailures),
		)
	}
}

type dependencyReport struct {
	// TaskCount is the number of analyzed tasks.
	TaskCount int
	// Issues is the flattened issue list across all tasks.
	Issues []*pb.DependencyIssue
	// TaskStatuses contains one status per analyzed task.
	TaskStatuses []*pb.TaskDependencyStatus
}

const (
	dependencyWriteOperationUpdateLabels  = "update_labels"
	dependencyWriteOperationUpdateContent = "update_content"
)

func (s *dependencyServer) analyze(ctx context.Context) (*dependencyReport, error) {
	client, err := s.getClient()
	if err != nil {
		return nil, err
	}

	tasks, err := client.ListActiveTasks(ctx)
	if err != nil {
		return nil, dependencyExternalStatusError("list active Todoist tasks", err)
	}

	return buildDependencyReport(tasks), nil
}

func (s *dependencyServer) reconcile(
	ctx context.Context,
) (*dependencyReport, int, []*pb.DependencyWriteFailure, error) {
	s.reconcileMu.Lock()
	defer s.reconcileMu.Unlock()

	client, err := s.getClient()
	if err != nil {
		return nil, 0, nil, err
	}

	ensureCtx, cancelEnsure := boundedContext(ctx, s.readTimeout)
	ensureResult, err := client.EnsureLabels(ensureCtx, dependency.ReservedLabels())
	cancelEnsure()
	if err != nil {
		return nil, 0, nil, dependencyExternalStatusError("ensure reserved Todoist labels", err)
	}
	if len(ensureResult.Failures) > 0 {
		log.Warningf("ensure reserved labels partial failures: %v", ensureResult.Failures)
	}

	listCtx, cancelList := boundedContext(ctx, s.readTimeout)
	tasks, err := client.ListActiveTasks(listCtx)
	cancelList()
	if err != nil {
		return nil, 0, nil, dependencyExternalStatusError("list active Todoist tasks", err)
	}

	report := buildDependencyReport(tasks)
	statusByTaskID := make(map[string]*pb.TaskDependencyStatus, len(report.TaskStatuses))
	for _, statusItem := range report.TaskStatuses {
		if statusItem == nil {
			continue
		}
		statusByTaskID[statusItem.GetTodoistTaskId()] = statusItem
	}

	now := time.Now()
	updatedCount := 0
	writeFailures := make([]*pb.DependencyWriteFailure, 0)
	for _, task := range tasks {
		if task == nil {
			continue
		}
		statusItem := statusByTaskID[task.ID]
		if statusItem == nil {
			continue
		}
		if withinGracePeriod(task.UpdatedAt, now, s.gracePeriod) {
			// Skip very recent tasks to reduce write races with user edits.
			continue
		}
		desired := desiredReservedLabelsFromTaskStatus(statusItem)
		diff := dependency.ComputeReservedLabelDiff(task.Labels, desired)
		if len(diff.AddLabels) == 0 && len(diff.RemoveLabels) == 0 {
			continue
		}
		writeCtx, cancelWrite := boundedContext(ctx, s.writeTimeout)
		_, updateErr := client.UpdateTaskLabels(writeCtx, task.ID, diff.AddLabels, diff.RemoveLabels)
		cancelWrite()
		if updateErr != nil {
			writeFailures = append(writeFailures, newDependencyWriteFailure(
				task.ID,
				statusItem.GetTaskKey(),
				dependencyWriteOperationUpdateLabels,
				dependencyOperationMessage("update Todoist task labels", updateErr),
			))
			continue
		}
		updatedCount++
	}

	return report, updatedCount, writeFailures, nil
}

// buildDependencyReport converts Todoist tasks into analyzer input and proto responses.
func buildDependencyReport(tasks []*todoist.Task) *dependencyReport {
	depTasks := make([]dependency.Task, 0, len(tasks))
	tasksByID := make(map[string]*todoist.Task, len(tasks))
	for _, task := range tasks {
		if task == nil {
			continue
		}
		parsed := dependency.ParseTaskMetadata(task.Content)
		depTasks = append(depTasks, dependency.Task{
			TodoistTaskID: task.ID,
			Content:       task.Content,
			Completed:     isTodoistTaskCompleted(task),
			Labels:        append([]string(nil), task.Labels...),
			Metadata:      parsed,
		})
		tasksByID[task.ID] = task
	}

	analysis := dependency.AnalyzeTasks(depTasks)

	statuses := make([]*pb.TaskDependencyStatus, 0, len(analysis.TaskStatuses))
	for _, item := range analysis.TaskStatuses {
		issues := make([]*pb.DependencyIssue, 0, len(item.Issues))
		for _, issue := range item.Issues {
			issues = append(issues, toProtoIssue(issue))
		}
		sort.Slice(issues, func(i, j int) bool {
			if issues[i].GetType() != issues[j].GetType() {
				return issues[i].GetType() < issues[j].GetType()
			}
			if issues[i].GetTaskKey() != issues[j].GetTaskKey() {
				return issues[i].GetTaskKey() < issues[j].GetTaskKey()
			}
			return issues[i].GetReferencedTaskKey() < issues[j].GetReferencedTaskKey()
		})

		statuses = append(statuses, &pb.TaskDependencyStatus{
			TaskKey:             item.TaskKey,
			TodoistTaskId:       item.TodoistTaskID,
			Readiness:           toProtoReadiness(item.Readiness),
			UnmetDependencyKeys: append([]string(nil), item.UnmetDependencyKeys...),
			Issues:              issues,
			TodoistTask:         normalizedTaskFromTodoistTask(tasksByID[item.TodoistTaskID]),
		})
	}

	protoIssues := make([]*pb.DependencyIssue, 0, len(analysis.Issues))
	for _, issue := range analysis.Issues {
		protoIssues = append(protoIssues, toProtoIssue(issue))
	}

	return &dependencyReport{
		TaskCount:    analysis.TaskCount,
		Issues:       protoIssues,
		TaskStatuses: statuses,
	}
}

// desiredReservedLabelsFromTaskStatus maps analysis output to DAG-managed Todoist labels.
func desiredReservedLabelsFromTaskStatus(statusItem *pb.TaskDependencyStatus) []string {
	desired := make([]string, 0, 4)
	switch statusItem.GetReadiness() {
	case pb.TaskReadinessState_TASK_READINESS_STATE_BLOCKED:
		desired = append(desired, dependency.LabelBlocked)
	case pb.TaskReadinessState_TASK_READINESS_STATE_COMPLETED:
		return nil
	}

	for _, issue := range statusItem.GetIssues() {
		if issue == nil {
			continue
		}
		switch issue.GetType() {
		case pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_PARSE_ERROR,
			pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_INVALID_KEY,
			pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_DUPLICATE_KEY:
			desired = append(desired, dependency.LabelInvalidMeta)
		case pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_BROKEN_REFERENCE:
			desired = append(desired, dependency.LabelBrokenDep)
		case pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_CYCLE:
			desired = append(desired, dependency.LabelCycle)
		}
	}

	return dedupeStrings(desired)
}

// toProtoIssue converts internal dependency issue types to API enum values.
func toProtoIssue(issue dependency.Issue) *pb.DependencyIssue {
	out := &pb.DependencyIssue{
		TaskKey:           issue.TaskKey,
		ReferencedTaskKey: issue.ReferencedTaskKey,
		TodoistTaskId:     issue.TodoistTaskID,
		Message:           issue.Message,
	}
	switch issue.Kind {
	case dependency.IssueKindParseError:
		out.Type = pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_PARSE_ERROR
	case dependency.IssueKindInvalidKey:
		out.Type = pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_INVALID_KEY
	case dependency.IssueKindDuplicateKey:
		out.Type = pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_DUPLICATE_KEY
	case dependency.IssueKindBrokenReference:
		out.Type = pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_BROKEN_REFERENCE
	case dependency.IssueKindCycle:
		out.Type = pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_CYCLE
	default:
		out.Type = pb.DependencyIssueType_DEPENDENCY_ISSUE_TYPE_UNSPECIFIED
	}
	return out
}

// toProtoReadiness converts internal readiness state to API enum values.
func toProtoReadiness(state dependency.ReadinessState) pb.TaskReadinessState {
	switch state {
	case dependency.ReadinessStateReady:
		return pb.TaskReadinessState_TASK_READINESS_STATE_READY
	case dependency.ReadinessStateBlocked:
		return pb.TaskReadinessState_TASK_READINESS_STATE_BLOCKED
	case dependency.ReadinessStateCompleted:
		return pb.TaskReadinessState_TASK_READINESS_STATE_COMPLETED
	case dependency.ReadinessStateInvalid:
		return pb.TaskReadinessState_TASK_READINESS_STATE_INVALID
	default:
		return pb.TaskReadinessState_TASK_READINESS_STATE_UNSPECIFIED
	}
}

// withinGracePeriod reports whether an update timestamp is too recent to mutate labels.
func withinGracePeriod(updatedAt string, now time.Time, grace time.Duration) bool {
	if grace <= 0 {
		return false
	}
	updatedAt = strings.TrimSpace(updatedAt)
	if updatedAt == "" {
		return false
	}

	parsed, err := time.Parse(time.RFC3339Nano, updatedAt)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339, updatedAt)
		if err != nil {
			return false
		}
	}

	delta := now.Sub(parsed)
	return delta >= 0 && delta < grace
}

// dedupeStrings removes duplicates and returns a stable sorted slice.
func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

func boundedContext(parent context.Context, limit time.Duration) (context.Context, context.CancelFunc) {
	if limit <= 0 {
		return context.WithCancel(parent)
	}
	return context.WithTimeout(parent, limit)
}

func isTimeoutLikeError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}

	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func dependencyExternalStatusError(action string, err error) error {
	if isTimeoutLikeError(err) {
		return status.Errorf(codes.DeadlineExceeded, "%s timed out: %v", action, err)
	}
	return status.Errorf(codes.Internal, "failed to %s: %v", action, err)
}

func dependencyOperationMessage(action string, err error) string {
	if isTimeoutLikeError(err) {
		return action + " timed out: " + err.Error()
	}
	return "failed to " + action + ": " + err.Error()
}

func newDependencyWriteFailure(
	taskID string,
	taskKey string,
	operation string,
	message string,
) *pb.DependencyWriteFailure {
	return &pb.DependencyWriteFailure{
		TodoistTaskId: taskID,
		TaskKey:       strings.TrimSpace(taskKey),
		Operation:     operation,
		ErrorMessage:  message,
	}
}

func metadataBootstrapExcludedProjectSet(excludedProjectIDs string) map[string]struct{} {
	out := make(map[string]struct{})

	for _, raw := range strings.Split(excludedProjectIDs, ",") {
		projectID := strings.TrimSpace(raw)
		if projectID == "" {
			continue
		}
		out[projectID] = struct{}{}
	}

	if len(out) == 0 {
		return nil
	}
	return out
}

func (s *dependencyServer) isMetadataBootstrapExcludedProject(projectID string) bool {
	if len(s.metadataExcludedProjectIDs) == 0 {
		return false
	}

	projectID = strings.TrimSpace(projectID)
	if projectID == "" {
		return false
	}

	_, excluded := s.metadataExcludedProjectIDs[projectID]
	return excluded
}
