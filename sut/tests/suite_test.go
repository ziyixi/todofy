package tests

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	sutSuiteAPI       = "api"
	sutSuiteScheduler = "scheduler"
)

// Select the tests matching the stack; separate Compose stacks provide state isolation.
func parseSUTSuite(value string) (string, error) {
	switch value {
	case "", sutSuiteAPI:
		return sutSuiteAPI, nil
	case sutSuiteScheduler:
		return sutSuiteScheduler, nil
	default:
		return "", fmt.Errorf("invalid TODOFY_SUT_SUITE %q: use api or scheduler", value)
	}
}

func TestParseSUTSuite(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value string
		want  string
	}{
		{name: "default disables scheduler coverage", want: sutSuiteAPI},
		{name: "explicit API suite", value: sutSuiteAPI, want: sutSuiteAPI},
		{name: "isolated scheduler suite", value: sutSuiteScheduler, want: sutSuiteScheduler},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseSUTSuite(tc.value)
			require.NoError(t, err)
			assert.Equal(t, tc.want, got)
		})
	}

	t.Run("unknown suite fails instead of silently skipping coverage", func(t *testing.T) {
		_, err := parseSUTSuite("typo")
		require.ErrorContains(t, err, "invalid TODOFY_SUT_SUITE")
	})
}
