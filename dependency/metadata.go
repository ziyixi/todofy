package dependency

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/gosimple/slug"
)

var taskKeyRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

const defaultGeneratedTaskKeyBase = "task"

// ParseErrorKind distinguishes parse error categories for metadata.
type ParseErrorKind int

const (
	ParseErrorKindNone ParseErrorKind = iota
	ParseErrorKindSyntax
	ParseErrorKindInvalidKey
)

// ParsedMetadata contains parsed dependency metadata and the display title.
type ParsedMetadata struct {
	DisplayTitle   string
	TaskKey        string
	DependencyKeys []string
	Valid          bool
	ParseError     string
	ErrorKind      ParseErrorKind
	HasMetadata    bool
}

// ParseTaskMetadata parses trailing metadata from a task title.
//
// Supported metadata form:
//
//	Task title <k:task-key dep:other-key,third-key>
func ParseTaskMetadata(content string) ParsedMetadata {
	trimmed := strings.TrimSpace(content)
	parsed := ParsedMetadata{
		DisplayTitle: trimmed,
		Valid:        true,
	}

	if trimmed == "" || !strings.HasSuffix(trimmed, ">") {
		return parsed
	}

	openIdx := strings.LastIndex(trimmed, "<")
	if openIdx <= 0 || openIdx >= len(trimmed)-1 {
		return parsed
	}

	block := strings.TrimSpace(trimmed[openIdx+1 : len(trimmed)-1])
	if block == "" {
		return parsed
	}

	if strings.Contains(block, "<") || strings.Contains(block, ">") {
		return parsed
	}

	// Ignore trailing angle-bracket fragments that do not look like metadata.
	if !strings.Contains(block, "k:") && !strings.Contains(block, "dep:") {
		return parsed
	}

	parsed.HasMetadata = true
	parsed.DisplayTitle = strings.TrimSpace(trimmed[:openIdx])

	parts := strings.Fields(block)
	if len(parts) == 0 {
		return invalidParsedMetadata(parsed, "metadata block is empty", ParseErrorKindSyntax)
	}

	seenTaskKey := false
	seenDeps := false
	for _, part := range parts {
		kv := strings.SplitN(part, ":", 2)
		if len(kv) != 2 {
			return invalidParsedMetadata(parsed, fmt.Sprintf("invalid metadata token %q", part), ParseErrorKindSyntax)
		}
		name := strings.TrimSpace(kv[0])
		value := strings.TrimSpace(kv[1])

		switch name {
		case "k":
			if seenTaskKey {
				return invalidParsedMetadata(parsed, "task key provided more than once", ParseErrorKindSyntax)
			}
			if value == "" {
				return invalidParsedMetadata(parsed, "task key is empty", ParseErrorKindSyntax)
			}
			if !isValidTaskKey(value) {
				return invalidParsedMetadata(parsed, fmt.Sprintf("invalid task key %q", value), ParseErrorKindInvalidKey)
			}
			parsed.TaskKey = value
			seenTaskKey = true
		case "dep":
			if seenDeps {
				return invalidParsedMetadata(parsed, "dependency list provided more than once", ParseErrorKindSyntax)
			}
			deps, err := parseDependencyKeys(value)
			if err != nil {
				kind := ParseErrorKindSyntax
				if strings.Contains(err.Error(), "invalid dependency key") {
					kind = ParseErrorKindInvalidKey
				}
				return invalidParsedMetadata(parsed, err.Error(), kind)
			}
			parsed.DependencyKeys = deps
			seenDeps = true
		default:
			return invalidParsedMetadata(parsed, fmt.Sprintf("unknown metadata field %q", name), ParseErrorKindSyntax)
		}
	}

	if len(parsed.DependencyKeys) > 0 && parsed.TaskKey == "" {
		return invalidParsedMetadata(parsed, "dependencies require a task key", ParseErrorKindSyntax)
	}

	return parsed
}

// BuildContentWithTaskKey injects or updates the task key in trailing metadata.
func BuildContentWithTaskKey(content string, taskKey string) (string, error) {
	if !isValidTaskKey(taskKey) {
		return "", fmt.Errorf("invalid task key %q", taskKey)
	}

	parsed := ParseTaskMetadata(content)
	if !parsed.Valid {
		return "", fmt.Errorf("invalid existing metadata: %s", parsed.ParseError)
	}

	return RenderTaskContent(parsed.DisplayTitle, taskKey, parsed.DependencyKeys)
}

// RenderTaskContent builds title content with metadata.
func RenderTaskContent(displayTitle string, taskKey string, dependencyKeys []string) (string, error) {
	displayTitle = strings.TrimSpace(displayTitle)
	if displayTitle == "" {
		return "", fmt.Errorf("display title cannot be empty")
	}
	if !isValidTaskKey(taskKey) {
		return "", fmt.Errorf("invalid task key %q", taskKey)
	}

	deps, err := normalizeDependencyKeys(dependencyKeys)
	if err != nil {
		return "", err
	}

	parts := []string{fmt.Sprintf("k:%s", taskKey)}
	if len(deps) > 0 {
		parts = append(parts, "dep:"+strings.Join(deps, ","))
	}
	return fmt.Sprintf("%s <%s>", displayTitle, strings.Join(parts, " ")), nil
}

// GenerateTaskKey builds a concise, metadata-safe key from a title.
// Keys use slug + short hash and are deduplicated against used.
// The used map is both read and updated by this function.
func GenerateTaskKey(displayTitle string, used map[string]struct{}) string {
	base := slug.Make(displayTitle)
	if base == "" {
		base = defaultGeneratedTaskKeyBase
	}
	base = strings.Trim(base, "-_")
	if base == "" {
		base = defaultGeneratedTaskKeyBase
	}

	// Keep keys concise and still leave room for "-"+6 hex chars.
	const hashLen = 6
	maxBaseLen := 64 - 1 - hashLen
	base = truncateTaskKey(base, maxBaseLen)
	base = strings.Trim(base, "-_")
	if base == "" {
		base = defaultGeneratedTaskKeyBase
	}

	for salt := 0; ; salt++ {
		candidate := fmt.Sprintf("%s-%s", base, shortTaskKeyHash(displayTitle, salt, hashLen))
		if _, exists := used[candidate]; !exists {
			used[candidate] = struct{}{}
			return candidate
		}
	}
}

func shortTaskKeyHash(displayTitle string, salt int, hashLen int) string {
	payload := strings.TrimSpace(displayTitle)
	sum := sha1.Sum([]byte(fmt.Sprintf("%s#%d", payload, salt)))
	hexValue := hex.EncodeToString(sum[:])
	if hashLen <= 0 || hashLen >= len(hexValue) {
		return hexValue
	}
	return hexValue[:hashLen]
}

func parseDependencyKeys(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		return nil, fmt.Errorf("dependency list is empty")
	}

	parts := strings.Split(value, ",")
	deps := make([]string, 0, len(parts))
	seen := make(map[string]struct{}, len(parts))
	for _, part := range parts {
		key := strings.TrimSpace(part)
		if key == "" {
			return nil, fmt.Errorf("dependency list contains an empty key")
		}
		if !isValidTaskKey(key) {
			return nil, fmt.Errorf("invalid dependency key %q", key)
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		deps = append(deps, key)
	}
	return deps, nil
}

func normalizeDependencyKeys(keys []string) ([]string, error) {
	seen := make(map[string]struct{}, len(keys))
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if key == "" {
			return nil, fmt.Errorf("dependency key is empty")
		}
		if !isValidTaskKey(key) {
			return nil, fmt.Errorf("invalid dependency key %q", key)
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out, nil
}

func invalidParsedMetadata(parsed ParsedMetadata, reason string, kind ParseErrorKind) ParsedMetadata {
	parsed.Valid = false
	parsed.ParseError = reason
	parsed.ErrorKind = kind
	parsed.TaskKey = ""
	parsed.DependencyKeys = nil
	return parsed
}

func isValidTaskKey(taskKey string) bool {
	return taskKeyRegex.MatchString(strings.TrimSpace(taskKey))
}

func truncateTaskKey(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func sortedUniqueLabels(labels []string) []string {
	seen := make(map[string]struct{}, len(labels))
	out := make([]string, 0, len(labels))
	for _, label := range labels {
		if _, exists := seen[label]; exists {
			continue
		}
		seen[label] = struct{}{}
		out = append(out, label)
	}
	sort.Strings(out)
	return out
}
