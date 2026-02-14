package main

import (
	"sync"
	"time"
)

// tokenRecord stores a single token usage entry with its timestamp.
type tokenRecord struct {
	timestamp time.Time
	tokens    int32
}

// TokenTracker tracks token usage within a sliding window and enforces a daily limit.
type TokenTracker struct {
	mu       sync.Mutex
	records  []tokenRecord
	window   time.Duration
	limit    int32
	timeFunc func() time.Time // for testing
}

// NewTokenTracker creates a new TokenTracker with the given window duration and token limit.
// A limit of 0 disables tracking (unlimited).
func NewTokenTracker(window time.Duration, limit int32) *TokenTracker {
	return &TokenTracker{
		records:  make([]tokenRecord, 0),
		window:   window,
		limit:    limit,
		timeFunc: time.Now,
	}
}

// prune removes records outside the sliding window. Must be called with mu held.
func (t *TokenTracker) prune() {
	cutoff := t.timeFunc().Add(-t.window)
	i := 0
	for i < len(t.records) && t.records[i].timestamp.Before(cutoff) {
		i++
	}
	t.records = t.records[i:]
}

// CurrentUsage returns the total token usage within the current sliding window.
func (t *TokenTracker) CurrentUsage() int32 {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.prune()
	var total int32
	for _, r := range t.records {
		total += r.tokens
	}
	return total
}

// CheckLimit returns an error message if adding the given tokens would exceed the limit.
// Returns empty string if within limit or if limit is disabled (0).
func (t *TokenTracker) CheckLimit(tokens int32) string {
	if t.limit <= 0 {
		return ""
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	t.prune()
	var total int32
	for _, r := range t.records {
		total += r.tokens
	}

	if total+tokens > t.limit {
		return "daily token limit exceeded"
	}
	return ""
}

// Record adds a token usage entry at the current time.
func (t *TokenTracker) Record(tokens int32) {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.records = append(t.records, tokenRecord{
		timestamp: t.timeFunc(),
		tokens:    tokens,
	})
}
