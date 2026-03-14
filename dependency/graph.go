package dependency

import (
	"fmt"
	"sort"
)

// IssueKind is the normalized dependency issue category.
type IssueKind string

const (
	IssueKindParseError      IssueKind = "parse_error"
	IssueKindInvalidKey      IssueKind = "invalid_key"
	IssueKindDuplicateKey    IssueKind = "duplicate_key"
	IssueKindBrokenReference IssueKind = "broken_reference"
	IssueKindCycle           IssueKind = "cycle"
)

// ReadinessState is the computed execution state for a task.
type ReadinessState string

const (
	ReadinessStateReady     ReadinessState = "ready"
	ReadinessStateBlocked   ReadinessState = "blocked"
	ReadinessStateCompleted ReadinessState = "completed"
	ReadinessStateInvalid   ReadinessState = "invalid"
)

// Task is the analyzer input model.
type Task struct {
	TodoistTaskID string
	Content       string
	Completed     bool
	Labels        []string
	Metadata      ParsedMetadata
}

// Issue is an analyzer issue record.
type Issue struct {
	Kind              IssueKind
	TaskKey           string
	ReferencedTaskKey string
	TodoistTaskID     string
	Message           string
}

// TaskStatus is the per-task analyzer output.
type TaskStatus struct {
	TaskKey             string
	TodoistTaskID       string
	Readiness           ReadinessState
	UnmetDependencyKeys []string
	Issues              []Issue
	DesiredLabels       []string
}

// Analysis is the aggregate graph analysis result.
type Analysis struct {
	TaskCount    int
	Issues       []Issue
	TaskStatuses []TaskStatus
}

type issueAppender func(index int, issue Issue)

// AnalyzeTasks computes dependency statuses, issues, and desired DAG labels.
func AnalyzeTasks(tasks []Task) Analysis {
	result := Analysis{
		TaskCount:    len(tasks),
		TaskStatuses: make([]TaskStatus, len(tasks)),
	}

	parsed := make([]ParsedMetadata, len(tasks))
	issuesByIndex := make([][]Issue, len(tasks))
	addIssue := func(index int, issue Issue) {
		issuesByIndex[index] = append(issuesByIndex[index], issue)
		result.Issues = append(result.Issues, issue)
	}

	keyToIndexes := collectMetadataAndSeedIssues(tasks, parsed, result.TaskStatuses, addIssue)
	keyToIndex, duplicateKeys := buildUniqueKeyIndex(tasks, keyToIndexes, addIssue)
	brokenDepsByIndex := collectBrokenDependencies(tasks, parsed, keyToIndexes, duplicateKeys, addIssue)
	adjacency := buildAdjacency(parsed, keyToIndex, duplicateKeys, brokenDepsByIndex)
	recordCycleIssues(tasks, keyToIndex, detectCycleKeys(adjacency), addIssue)
	finalizeStatuses(tasks, parsed, keyToIndex, issuesByIndex, result.TaskStatuses)

	sortIssues(result.Issues)
	return result
}

func collectMetadataAndSeedIssues(
	tasks []Task,
	parsed []ParsedMetadata,
	statuses []TaskStatus,
	addIssue issueAppender,
) map[string][]int {
	keyToIndexes := make(map[string][]int)
	for i, task := range tasks {
		meta := task.Metadata
		if !meta.Valid && meta.ParseError == "" && meta.DisplayTitle == "" && !meta.HasMetadata {
			meta = ParseTaskMetadata(task.Content)
		}
		parsed[i] = meta
		statuses[i] = TaskStatus{
			TaskKey:       meta.TaskKey,
			TodoistTaskID: task.TodoistTaskID,
		}

		if !meta.Valid {
			kind := IssueKindParseError
			if meta.ErrorKind == ParseErrorKindInvalidKey {
				kind = IssueKindInvalidKey
			}
			addIssue(i, Issue{
				Kind:          kind,
				TaskKey:       meta.TaskKey,
				TodoistTaskID: task.TodoistTaskID,
				Message:       meta.ParseError,
			})
			continue
		}

		if meta.TaskKey != "" {
			keyToIndexes[meta.TaskKey] = append(keyToIndexes[meta.TaskKey], i)
		}
	}
	return keyToIndexes
}

func buildUniqueKeyIndex(
	tasks []Task,
	keyToIndexes map[string][]int,
	addIssue issueAppender,
) (map[string]int, map[string]struct{}) {
	keyToIndex := make(map[string]int, len(keyToIndexes))
	duplicateKeys := make(map[string]struct{})
	for key, indexes := range keyToIndexes {
		if len(indexes) == 1 {
			keyToIndex[key] = indexes[0]
			continue
		}
		duplicateKeys[key] = struct{}{}
		for _, index := range indexes {
			addIssue(index, Issue{
				Kind:          IssueKindDuplicateKey,
				TaskKey:       key,
				TodoistTaskID: tasks[index].TodoistTaskID,
				Message:       fmt.Sprintf("duplicate task key %q", key),
			})
		}
	}
	return keyToIndex, duplicateKeys
}

func collectBrokenDependencies(
	tasks []Task,
	parsed []ParsedMetadata,
	keyToIndexes map[string][]int,
	duplicateKeys map[string]struct{},
	addIssue issueAppender,
) [][]string {
	brokenDepsByIndex := make([][]string, len(tasks))
	for i, task := range tasks {
		meta := parsed[i]
		if !meta.Valid || meta.TaskKey == "" {
			continue
		}
		if _, duplicate := duplicateKeys[meta.TaskKey]; duplicate {
			continue
		}
		for _, depKey := range meta.DependencyKeys {
			indexes, exists := keyToIndexes[depKey]
			if !exists || len(indexes) == 0 {
				brokenDepsByIndex[i] = append(brokenDepsByIndex[i], depKey)
				addIssue(i, Issue{
					Kind:              IssueKindBrokenReference,
					TaskKey:           meta.TaskKey,
					ReferencedTaskKey: depKey,
					TodoistTaskID:     task.TodoistTaskID,
					Message:           fmt.Sprintf("dependency key %q does not exist", depKey),
				})
				continue
			}
			if len(indexes) > 1 {
				brokenDepsByIndex[i] = append(brokenDepsByIndex[i], depKey)
				addIssue(i, Issue{
					Kind:              IssueKindBrokenReference,
					TaskKey:           meta.TaskKey,
					ReferencedTaskKey: depKey,
					TodoistTaskID:     task.TodoistTaskID,
					Message:           fmt.Sprintf("dependency key %q is duplicated", depKey),
				})
			}
		}
	}
	return brokenDepsByIndex
}

func buildAdjacency(
	parsed []ParsedMetadata,
	keyToIndex map[string]int,
	duplicateKeys map[string]struct{},
	brokenDepsByIndex [][]string,
) map[string][]string {
	adjacency := make(map[string][]string)
	for key, index := range keyToIndex {
		meta := parsed[index]
		if !meta.Valid {
			continue
		}
		if _, duplicate := duplicateKeys[key]; duplicate {
			continue
		}
		if len(brokenDepsByIndex[index]) > 0 {
			continue
		}
		for _, depKey := range meta.DependencyKeys {
			if _, exists := keyToIndex[depKey]; exists {
				adjacency[key] = append(adjacency[key], depKey)
			}
		}
	}
	return adjacency
}

func recordCycleIssues(
	tasks []Task,
	keyToIndex map[string]int,
	cycleKeys map[string]struct{},
	addIssue issueAppender,
) {
	for key := range cycleKeys {
		index := keyToIndex[key]
		addIssue(index, Issue{
			Kind:          IssueKindCycle,
			TaskKey:       key,
			TodoistTaskID: tasks[index].TodoistTaskID,
			Message:       fmt.Sprintf("task key %q participates in a dependency cycle", key),
		})
	}
}

func finalizeStatuses(
	tasks []Task,
	parsed []ParsedMetadata,
	keyToIndex map[string]int,
	issuesByIndex [][]Issue,
	statuses []TaskStatus,
) {
	for i, task := range tasks {
		status := statuses[i]
		status.Issues = append(status.Issues, issuesByIndex[i]...)
		sortIssues(status.Issues)

		hasInvalidMeta := hasIssue(status.Issues, IssueKindParseError, IssueKindInvalidKey, IssueKindDuplicateKey)
		hasBrokenRef := hasIssue(status.Issues, IssueKindBrokenReference)
		hasCycle := hasIssue(status.Issues, IssueKindCycle)

		readiness, unmet := evaluateReadiness(
			task,
			parsed[i],
			keyToIndex,
			tasks,
			hasInvalidMeta,
			hasBrokenRef,
			hasCycle,
		)
		status.Readiness = readiness
		status.UnmetDependencyKeys = unmet
		status.DesiredLabels = desiredReservedLabels(task.Completed, readiness, hasInvalidMeta, hasBrokenRef, hasCycle)
		statuses[i] = status
	}
}

func evaluateReadiness(
	task Task,
	meta ParsedMetadata,
	keyToIndex map[string]int,
	tasks []Task,
	hasInvalidMeta bool,
	hasBrokenRef bool,
	hasCycle bool,
) (ReadinessState, []string) {
	switch {
	case task.Completed:
		return ReadinessStateCompleted, nil
	case hasInvalidMeta || hasBrokenRef || hasCycle:
		return ReadinessStateInvalid, nil
	case meta.TaskKey == "":
		return ReadinessStateReady, nil
	default:
		unmet := unresolvedDependencies(meta.DependencyKeys, keyToIndex, tasks)
		if len(unmet) > 0 {
			return ReadinessStateBlocked, unmet
		}
		return ReadinessStateReady, unmet
	}
}

func unresolvedDependencies(depKeys []string, keyToIndex map[string]int, tasks []Task) []string {
	unmet := make([]string, 0, len(depKeys))
	for _, depKey := range depKeys {
		depIndex, exists := keyToIndex[depKey]
		if !exists {
			continue
		}
		if tasks[depIndex].Completed {
			continue
		}
		unmet = append(unmet, depKey)
	}
	return dedupePreserveOrder(unmet)
}

func desiredReservedLabels(
	completed bool,
	readiness ReadinessState,
	hasInvalidMeta bool,
	hasBrokenRef bool,
	hasCycle bool,
) []string {
	if completed {
		return nil
	}

	desired := make([]string, 0, 4)
	if hasInvalidMeta {
		desired = append(desired, LabelInvalidMeta)
	}
	if hasBrokenRef {
		desired = append(desired, LabelBrokenDep)
	}
	if hasCycle {
		desired = append(desired, LabelCycle)
	}
	if readiness == ReadinessStateBlocked {
		desired = append(desired, LabelBlocked)
	}

	return sortedUniqueLabels(desired)
}

// LabelDiff captures minimal DAG-managed label changes for one task.
type LabelDiff struct {
	AddLabels    []string
	RemoveLabels []string
}

// ComputeReservedLabelDiff computes add/remove operations only for reserved DAG labels.
func ComputeReservedLabelDiff(currentLabels []string, desiredReservedLabels []string) LabelDiff {
	currentReserved := make(map[string]struct{})
	for _, label := range currentLabels {
		if !IsReservedLabel(label) {
			continue
		}
		currentReserved[label] = struct{}{}
	}

	desiredReserved := make(map[string]struct{})
	for _, label := range desiredReservedLabels {
		if !IsReservedLabel(label) {
			continue
		}
		desiredReserved[label] = struct{}{}
	}

	diff := LabelDiff{}
	for label := range desiredReserved {
		if _, exists := currentReserved[label]; exists {
			continue
		}
		diff.AddLabels = append(diff.AddLabels, label)
	}

	for label := range currentReserved {
		if _, exists := desiredReserved[label]; exists {
			continue
		}
		diff.RemoveLabels = append(diff.RemoveLabels, label)
	}

	sort.Strings(diff.AddLabels)
	sort.Strings(diff.RemoveLabels)
	return diff
}

func hasIssue(issues []Issue, kinds ...IssueKind) bool {
	kindSet := make(map[IssueKind]struct{}, len(kinds))
	for _, kind := range kinds {
		kindSet[kind] = struct{}{}
	}
	for _, issue := range issues {
		if _, exists := kindSet[issue.Kind]; exists {
			return true
		}
	}
	return false
}

func dedupePreserveOrder(values []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func sortIssues(issues []Issue) {
	sort.Slice(issues, func(i, j int) bool {
		if issues[i].Kind != issues[j].Kind {
			return issues[i].Kind < issues[j].Kind
		}
		if issues[i].TaskKey != issues[j].TaskKey {
			return issues[i].TaskKey < issues[j].TaskKey
		}
		if issues[i].ReferencedTaskKey != issues[j].ReferencedTaskKey {
			return issues[i].ReferencedTaskKey < issues[j].ReferencedTaskKey
		}
		if issues[i].TodoistTaskID != issues[j].TodoistTaskID {
			return issues[i].TodoistTaskID < issues[j].TodoistTaskID
		}
		return issues[i].Message < issues[j].Message
	})
}

func detectCycleKeys(adjacency map[string][]string) map[string]struct{} {
	keys := make([]string, 0, len(adjacency))
	for key := range adjacency {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	state := make(map[string]int, len(adjacency))
	stack := make([]string, 0, len(adjacency))
	stackPos := make(map[string]int, len(adjacency))
	cycleKeys := make(map[string]struct{})

	var dfs func(string)
	dfs = func(key string) {
		state[key] = 1
		stackPos[key] = len(stack)
		stack = append(stack, key)

		for _, dep := range adjacency[key] {
			switch state[dep] {
			case 0:
				dfs(dep)
			case 1:
				start := stackPos[dep]
				for _, cycleKey := range stack[start:] {
					cycleKeys[cycleKey] = struct{}{}
				}
			}
		}

		stack = stack[:len(stack)-1]
		delete(stackPos, key)
		state[key] = 2
	}

	for _, key := range keys {
		if state[key] != 0 {
			continue
		}
		dfs(key)
	}

	return cycleKeys
}
