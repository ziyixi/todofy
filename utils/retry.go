package utils

import (
	"context"
	"time"
)

// RetryConfig configures retry behavior for Retry.
type RetryConfig struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}

// Retry runs operation with retry semantics determined by shouldRetry.
// operation receives a 1-based attempt number.
func Retry(
	ctx context.Context,
	cfg RetryConfig,
	operation func(attempt int) error,
	shouldRetry func(err error, attempt int) (retry bool, delay time.Duration),
) error {
	if cfg.MaxAttempts <= 0 {
		cfg.MaxAttempts = 1
	}
	if cfg.BaseDelay <= 0 {
		cfg.BaseDelay = 100 * time.Millisecond
	}

	var lastErr error
	for attempt := 1; attempt <= cfg.MaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}

		err := operation(attempt)
		if err == nil {
			return nil
		}
		lastErr = err

		if attempt == cfg.MaxAttempts {
			break
		}

		retry, delay := shouldRetry(err, attempt)
		if !retry {
			return err
		}
		if delay <= 0 {
			delay = exponentialBackoff(cfg.BaseDelay, attempt)
		}
		if cfg.MaxDelay > 0 && delay > cfg.MaxDelay {
			delay = cfg.MaxDelay
		}

		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return ctx.Err()
		case <-timer.C:
		}
	}

	return lastErr
}

func exponentialBackoff(baseDelay time.Duration, attempt int) time.Duration {
	if attempt <= 1 {
		return baseDelay
	}

	delay := baseDelay
	for i := 1; i < attempt; i++ {
		if delay > time.Duration(1<<62) {
			return delay
		}
		delay *= 2
	}
	return delay
}
