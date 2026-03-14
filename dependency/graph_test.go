package dependency

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAnalyzeTasks_DuplicateKey(t *testing.T) {
	tasks := []Task{
		{
			TodoistTaskID: "1",
			Content:       "A <k:dup-key>",
			Metadata:      ParseTaskMetadata("A <k:dup-key>"),
		},
		{
			TodoistTaskID: "2",
			Content:       "B <k:dup-key>",
			Metadata:      ParseTaskMetadata("B <k:dup-key>"),
		},
	}

	analysis := AnalyzeTasks(tasks)
	require.Len(t, analysis.TaskStatuses, 2)
	assert.Len(t, analysis.Issues, 2)

	for _, status := range analysis.TaskStatuses {
		assert.Equal(t, ReadinessStateInvalid, status.Readiness)
		assert.Contains(t, status.DesiredLabels, LabelInvalidMeta)
	}
}

func TestAnalyzeTasks_BrokenDependency(t *testing.T) {
	tasks := []Task{
		{
			TodoistTaskID: "1",
			Content:       "A <k:a dep:missing>",
			Metadata:      ParseTaskMetadata("A <k:a dep:missing>"),
		},
	}

	analysis := AnalyzeTasks(tasks)
	require.Len(t, analysis.TaskStatuses, 1)
	status := analysis.TaskStatuses[0]
	assert.Equal(t, ReadinessStateInvalid, status.Readiness)
	assert.Contains(t, status.DesiredLabels, LabelBrokenDep)
}

func TestAnalyzeTasks_Cycle(t *testing.T) {
	tasks := []Task{
		{
			TodoistTaskID: "1",
			Content:       "A <k:a dep:b>",
			Metadata:      ParseTaskMetadata("A <k:a dep:b>"),
		},
		{
			TodoistTaskID: "2",
			Content:       "B <k:b dep:a>",
			Metadata:      ParseTaskMetadata("B <k:b dep:a>"),
		},
	}

	analysis := AnalyzeTasks(tasks)
	require.Len(t, analysis.TaskStatuses, 2)

	for _, status := range analysis.TaskStatuses {
		assert.Equal(t, ReadinessStateInvalid, status.Readiness)
		assert.Contains(t, status.DesiredLabels, LabelCycle)
	}
}

func TestAnalyzeTasks_BlockedAndReady(t *testing.T) {
	tasks := []Task{
		{
			TodoistTaskID: "1",
			Content:       "A <k:a dep:b>",
			Metadata:      ParseTaskMetadata("A <k:a dep:b>"),
		},
		{
			TodoistTaskID: "2",
			Content:       "B <k:b>",
			Metadata:      ParseTaskMetadata("B <k:b>"),
		},
	}

	analysis := AnalyzeTasks(tasks)
	require.Len(t, analysis.TaskStatuses, 2)

	blocked := analysis.TaskStatuses[0]
	assert.Equal(t, ReadinessStateBlocked, blocked.Readiness)
	assert.Equal(t, []string{"b"}, blocked.UnmetDependencyKeys)
	assert.Contains(t, blocked.DesiredLabels, LabelBlocked)

	ready := analysis.TaskStatuses[1]
	assert.Equal(t, ReadinessStateReady, ready.Readiness)
	assert.NotContains(t, ready.DesiredLabels, LabelBlocked)

	tasks[1].Completed = true
	analysisAfterCompletion := AnalyzeTasks(tasks)
	require.Len(t, analysisAfterCompletion.TaskStatuses, 2)
	assert.Equal(t, ReadinessStateReady, analysisAfterCompletion.TaskStatuses[0].Readiness)
	assert.NotContains(t, analysisAfterCompletion.TaskStatuses[0].DesiredLabels, LabelBlocked)
}

func TestComputeReservedLabelDiff(t *testing.T) {
	diff := ComputeReservedLabelDiff(
		[]string{"priority", LabelBlocked, LabelCycle},
		[]string{LabelCycle, LabelBrokenDep},
	)

	assert.Equal(t, []string{LabelBrokenDep}, diff.AddLabels)
	assert.Equal(t, []string{LabelBlocked}, diff.RemoveLabels)
}
