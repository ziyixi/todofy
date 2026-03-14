package dependency

import (
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseTaskMetadata(t *testing.T) {
	t.Run("parses key and dependencies", func(t *testing.T) {
		parsed := ParseTaskMetadata("Task title <k:task-key dep:other-key,third-key>")
		require.True(t, parsed.Valid)
		assert.True(t, parsed.HasMetadata)
		assert.Equal(t, "Task title", parsed.DisplayTitle)
		assert.Equal(t, "task-key", parsed.TaskKey)
		assert.Equal(t, []string{"other-key", "third-key"}, parsed.DependencyKeys)
	})

	t.Run("returns no metadata when absent", func(t *testing.T) {
		parsed := ParseTaskMetadata("Task title only")
		require.True(t, parsed.Valid)
		assert.False(t, parsed.HasMetadata)
		assert.Equal(t, "Task title only", parsed.DisplayTitle)
		assert.Empty(t, parsed.TaskKey)
		assert.Empty(t, parsed.DependencyKeys)
	})

	t.Run("detects invalid key", func(t *testing.T) {
		parsed := ParseTaskMetadata("Task title <k:Bad-Key>")
		require.False(t, parsed.Valid)
		assert.Equal(t, ParseErrorKindInvalidKey, parsed.ErrorKind)
		assert.Contains(t, parsed.ParseError, "invalid task key")
	})

	t.Run("detects dep without key", func(t *testing.T) {
		parsed := ParseTaskMetadata("Task title <dep:root>")
		require.False(t, parsed.Valid)
		assert.Equal(t, ParseErrorKindSyntax, parsed.ErrorKind)
		assert.Contains(t, parsed.ParseError, "dependencies require a task key")
	})

	t.Run("ignores non-metadata angle bracket suffix", func(t *testing.T) {
		parsed := ParseTaskMetadata("Task title <v1>")
		require.True(t, parsed.Valid)
		assert.False(t, parsed.HasMetadata)
		assert.Equal(t, "Task title <v1>", parsed.DisplayTitle)
	})
}

func TestBuildContentWithTaskKey(t *testing.T) {
	content, err := BuildContentWithTaskKey("Task title <dep:ignored>", "task-key")
	assert.Error(t, err)
	assert.Empty(t, content)

	content, err = BuildContentWithTaskKey("Task title", "task-key")
	require.NoError(t, err)
	assert.Equal(t, "Task title <k:task-key>", content)

	content, err = BuildContentWithTaskKey("Task title <k:old dep:dep-one,dep-two>", "task-key")
	require.NoError(t, err)
	assert.Equal(t, "Task title <k:task-key dep:dep-one,dep-two>", content)
}

func TestGenerateTaskKey(t *testing.T) {
	t.Run("is deterministic for same title with fresh used map", func(t *testing.T) {
		keyOne := GenerateTaskKey("Task title", map[string]struct{}{})
		keyTwo := GenerateTaskKey("Task title", map[string]struct{}{})
		assert.Equal(t, keyOne, keyTwo)
		assert.Regexp(t, regexp.MustCompile(`^task-title-[a-f0-9]{6}$`), keyOne)
	})

	t.Run("uses different hash when collision occurs", func(t *testing.T) {
		used := map[string]struct{}{}
		first := GenerateTaskKey("Task title", used)
		second := GenerateTaskKey("Task title", used)
		assert.NotEqual(t, first, second)
		assert.Regexp(t, regexp.MustCompile(`^task-title-[a-f0-9]{6}$`), second)
	})

	t.Run("uses fallback base when slug is empty", func(t *testing.T) {
		key := GenerateTaskKey("!!!", map[string]struct{}{})
		assert.Regexp(t, regexp.MustCompile(`^task-[a-f0-9]{6}$`), key)
	})

	t.Run("uses gosimple slug transliteration", func(t *testing.T) {
		key := GenerateTaskKey("Über Café", map[string]struct{}{})
		assert.True(t, strings.HasPrefix(key, "uber-cafe-"))

		cjkKey := GenerateTaskKey("中文任务", map[string]struct{}{})
		assert.True(t, strings.HasPrefix(cjkKey, "zhong-wen-ren-wu-"))
	})

	t.Run("preserves underscore behavior from gosimple slug", func(t *testing.T) {
		key := GenerateTaskKey("A_B C", map[string]struct{}{})
		assert.True(t, strings.HasPrefix(key, "a_b-c-"))
	})
}
