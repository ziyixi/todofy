package utils

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestSlidingWindowLimiter_Reserve(t *testing.T) {
	limiter := NewSlidingWindowLimiter(2, time.Minute)
	now := time.Now()

	allowed, retryAfter := limiter.Reserve(now)
	assert.True(t, allowed)
	assert.Zero(t, retryAfter)

	allowed, retryAfter = limiter.Reserve(now.Add(10 * time.Second))
	assert.True(t, allowed)
	assert.Zero(t, retryAfter)

	allowed, retryAfter = limiter.Reserve(now.Add(20 * time.Second))
	assert.False(t, allowed)
	assert.Greater(t, retryAfter, 0*time.Second)
}

func TestSlidingWindowLimiter_PrunesExpiredEvents(t *testing.T) {
	limiter := NewSlidingWindowLimiter(1, time.Minute)
	now := time.Now()

	allowed, _ := limiter.Reserve(now)
	assert.True(t, allowed)

	allowed, _ = limiter.Reserve(now.Add(2 * time.Minute))
	assert.True(t, allowed)
}
