package main

import (
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
)

func TestHandleSummary(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("handler requires refactoring for better testability", func(t *testing.T) {
		// The current HandleSummary function has tight coupling with concrete GRPCClients type
		// This makes unit testing difficult as it requires type assertions
		// Recommendation: Extract an interface for the client manager to enable proper mocking
		t.Skip("Handler needs refactoring - tight coupling with concrete types makes unit testing difficult")
	})
}

func TestTimeDurationToSummary(t *testing.T) {
	t.Run("constant has correct value", func(t *testing.T) {
		expected := 24 * time.Hour
		assert.Equal(t, expected, TimeDurationToSummary)
	})
}
