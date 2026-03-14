package utils

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRetry_SucceedsAfterRetries(t *testing.T) {
	attempts := 0
	err := Retry(
		context.Background(),
		RetryConfig{MaxAttempts: 3, BaseDelay: time.Millisecond},
		func(_ int) error {
			attempts++
			if attempts < 3 {
				return errors.New("temporary")
			}
			return nil
		},
		func(_ error, _ int) (bool, time.Duration) {
			return true, 0
		},
	)
	require.NoError(t, err)
	assert.Equal(t, 3, attempts)
}

func TestRetry_StopsOnNonRetryableError(t *testing.T) {
	attempts := 0
	stopErr := errors.New("stop")
	err := Retry(
		context.Background(),
		RetryConfig{MaxAttempts: 5, BaseDelay: time.Millisecond},
		func(_ int) error {
			attempts++
			return stopErr
		},
		func(_ error, _ int) (bool, time.Duration) {
			return false, 0
		},
	)
	require.Error(t, err)
	assert.ErrorIs(t, err, stopErr)
	assert.Equal(t, 1, attempts)
}

func TestRetry_RespectsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := Retry(
		ctx,
		RetryConfig{MaxAttempts: 3, BaseDelay: time.Millisecond},
		func(_ int) error { return errors.New("temporary") },
		func(_ error, _ int) (bool, time.Duration) { return true, time.Millisecond },
	)
	require.Error(t, err)
	assert.ErrorIs(t, err, context.Canceled)
}
