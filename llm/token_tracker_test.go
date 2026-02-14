package main

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestTokenTracker_Record(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, 1000000)

	tracker.Record(5000)
	assert.Equal(t, int32(5000), tracker.CurrentUsage())

	tracker.Record(3000)
	assert.Equal(t, int32(8000), tracker.CurrentUsage())
}

func TestTokenTracker_CheckLimit_WithinLimit(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, 10000)

	tracker.Record(5000)
	msg := tracker.CheckLimit(4000)
	assert.Empty(t, msg)
}

func TestTokenTracker_CheckLimit_ExceedsLimit(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, 10000)

	tracker.Record(8000)
	msg := tracker.CheckLimit(3000)
	assert.Contains(t, msg, "daily token limit exceeded")
}

func TestTokenTracker_CheckLimit_ExactLimit(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, 10000)

	tracker.Record(5000)
	// Exactly at limit should pass
	msg := tracker.CheckLimit(5000)
	assert.Empty(t, msg)

	// One over should fail
	msg = tracker.CheckLimit(5001)
	assert.Contains(t, msg, "daily token limit exceeded")
}

func TestTokenTracker_CheckLimit_Disabled(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, 0)

	tracker.Record(9999999)
	msg := tracker.CheckLimit(9999999)
	assert.Empty(t, msg, "limit of 0 should disable tracking")
}

func TestTokenTracker_SlidingWindow_Expiry(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, 1000000)

	now := time.Now()

	// Record old usage (25 hours ago - outside window)
	tracker.timeFunc = func() time.Time { return now.Add(-25 * time.Hour) }
	tracker.Record(500000)

	// Record recent usage (1 hour ago - inside window)
	tracker.timeFunc = func() time.Time { return now.Add(-1 * time.Hour) }
	tracker.Record(200000)

	// Check from "now" - old record should be pruned
	tracker.timeFunc = func() time.Time { return now }
	assert.Equal(t, int32(200000), tracker.CurrentUsage())
}

func TestTokenTracker_SlidingWindow_NotExpired(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, 1000000)

	now := time.Now()

	// Record usage 23 hours ago (inside window)
	tracker.timeFunc = func() time.Time { return now.Add(-23 * time.Hour) }
	tracker.Record(300000)

	// Record usage 1 hour ago (inside window)
	tracker.timeFunc = func() time.Time { return now.Add(-1 * time.Hour) }
	tracker.Record(200000)

	// Both should count
	tracker.timeFunc = func() time.Time { return now }
	assert.Equal(t, int32(500000), tracker.CurrentUsage())
}

func TestTokenTracker_SlidingWindow_CheckLimitAfterExpiry(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, 500000)

	now := time.Now()

	// Fill up the limit 25 hours ago
	tracker.timeFunc = func() time.Time { return now.Add(-25 * time.Hour) }
	tracker.Record(500000)

	// Should now be within limit since old records expired
	tracker.timeFunc = func() time.Time { return now }
	msg := tracker.CheckLimit(100000)
	assert.Empty(t, msg, "should be within limit after old records expire")
}

func TestTokenTracker_MultipleRecords(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, 1000000)

	for i := 0; i < 100; i++ {
		tracker.Record(1000)
	}
	assert.Equal(t, int32(100000), tracker.CurrentUsage())
}

func TestTokenTracker_NegativeLimit(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, -1)

	tracker.Record(9999999)
	msg := tracker.CheckLimit(9999999)
	assert.Empty(t, msg, "negative limit should disable tracking like 0")
}

func TestTokenTracker_EmptyTracker(t *testing.T) {
	tracker := NewTokenTracker(24*time.Hour, 1000000)

	assert.Equal(t, int32(0), tracker.CurrentUsage())
	msg := tracker.CheckLimit(500000)
	assert.Empty(t, msg)
}
