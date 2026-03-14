package utils

import (
	"sync"
	"time"
)

// SlidingWindowLimiter enforces a fixed number of events over a rolling time window.
type SlidingWindowLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	events []time.Time
}

// NewSlidingWindowLimiter creates a limiter with the provided limit and window.
func NewSlidingWindowLimiter(limit int, window time.Duration) *SlidingWindowLimiter {
	return &SlidingWindowLimiter{
		limit:  limit,
		window: window,
		events: make([]time.Time, 0, limit),
	}
}

// Reserve attempts to consume one event at now.
// It returns whether the event is allowed and the retry-after duration if blocked.
func (l *SlidingWindowLimiter) Reserve(now time.Time) (bool, time.Duration) {
	if l == nil || l.limit <= 0 || l.window <= 0 {
		return true, 0
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	l.prune(now)
	if len(l.events) < l.limit {
		l.events = append(l.events, now)
		return true, 0
	}

	oldest := l.events[0]
	retryAfter := l.window - now.Sub(oldest)
	if retryAfter < 0 {
		retryAfter = 0
	}
	return false, retryAfter
}

func (l *SlidingWindowLimiter) prune(now time.Time) {
	cutoff := now.Add(-l.window)
	idx := 0
	for idx < len(l.events) && !l.events[idx].After(cutoff) {
		idx++
	}
	if idx == 0 {
		return
	}
	l.events = append([]time.Time(nil), l.events[idx:]...)
}
