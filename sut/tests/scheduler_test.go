package tests

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	admincontract "github.com/ziyixi/todofy/sut/contracts/admin"
	"github.com/ziyixi/todofy/todo/todoistapi"
)

// Run against a fresh stack with docker-compose.sut-scheduler.yml applied.
func TestSUTDependencySchedulerIntegration(t *testing.T) {
	h := newEnabledHarnessForSuite(t, sutSuiteScheduler)
	h.resetScenario(t)

	// Re-seeding after the first successful write ensures a later periodic tick,
	// not only startup bootstrap, generates metadata without a manual API call.
	for attempt := 0; attempt < 2; attempt++ {
		h.seedTodoist(t, admincontract.SeedTodoistStateRequest{
			Tasks: []todoistapi.Task{
				{ID: "1", Content: "Auto bootstrap task", ProjectID: sutProjectID},
			},
		})

		require.Eventually(t, func() bool {
			state := h.todoistState(t)
			if len(state.Tasks) != 1 {
				return false
			}
			return strings.Contains(state.Tasks[0].Content, "<k:")
		}, 30*time.Second, 250*time.Millisecond, "bootstrap attempt %d did not generate a key", attempt+1)
	}
}
