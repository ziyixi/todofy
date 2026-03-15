// Package todoist provides a client for interacting with the Todoist API.
package todoist

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ziyixi/todofy/utils"
)

const (
	// defaultTimeout specifies the default timeout for HTTP requests.
	defaultTimeout = 14 * time.Second

	todoistMaxPostBodyBytes = 1 << 20 // 1 MiB
	todoistMaxHeaderBytes   = 65 << 10

	todoistRateLimitCount  = 1000
	todoistRateLimitWindow = 15 * time.Minute
)

var (
	tokenLimiterMu sync.Mutex
	tokenLimiters  = map[string]*utils.SlidingWindowLimiter{}
)

// Client is a client for interacting with the Todoist API v1.
type Client struct {
	httpClient *http.Client
	token      string
	baseURL    string

	requestLimiter *utils.SlidingWindowLimiter
	retryConfig    utils.RetryConfig
}

// NewClient creates and returns a new Todoist API client.
func NewClient(token string) *Client {
	return &Client{
		httpClient: &http.Client{
			Timeout: defaultTimeout,
		},
		token:          token,
		baseURL:        defaultBaseURL,
		requestLimiter: limiterForToken(token),
		retryConfig: utils.RetryConfig{
			MaxAttempts: 3,
			BaseDelay:   250 * time.Millisecond,
			MaxDelay:    2 * time.Second,
		},
	}
}

// NewClientWithBaseURL creates a Todoist client with an optional base URL override.
func NewClientWithBaseURL(token string, baseURL string) *Client {
	client := NewClient(token)
	if trimmedBaseURL := strings.TrimSpace(baseURL); trimmedBaseURL != "" {
		normalizedBaseURL := strings.TrimRight(trimmedBaseURL, "/")
		if normalizedBaseURL == "" {
			normalizedBaseURL = trimmedBaseURL
		}
		client.baseURL = normalizedBaseURL
	}
	return client
}

// ErrorResponse represents an error returned by the Todoist API.
type ErrorResponse struct {
	ErrorMessage string `json:"error"`
	ErrorCode    int    `json:"error_code"`
	HTTPCode     int    `json:"http_code"`
}

// Error implements the error interface.
func (e ErrorResponse) Error() string {
	return fmt.Sprintf("todoist API error: %s (code: %d)", e.ErrorMessage, e.ErrorCode)
}

type todoistHTTPError struct {
	statusCode int
	body       string
	retryAfter time.Duration
}

func (e *todoistHTTPError) Error() string {
	message := truncateForError(strings.TrimSpace(e.body), 512)
	if e.statusCode == http.StatusTooManyRequests {
		if e.retryAfter > 0 {
			return fmt.Sprintf(
				"todoist API rate limited (429): retry after %s: %s",
				e.retryAfter.Truncate(time.Millisecond),
				message,
			)
		}
		return fmt.Sprintf("todoist API rate limited (429): %s", message)
	}
	return fmt.Sprintf("received non-2xx response status %d: %s", e.statusCode, message)
}

// CreateTask creates a new task.
func (c *Client) CreateTask(ctx context.Context, requestID string, taskDetails *CreateTaskRequest) (*Task, error) {
	var created Task
	if err := c.doJSON(ctx, http.MethodPost, todoistTasksPath, taskDetails, requestID, &created); err != nil {
		return nil, err
	}
	return &created, nil
}

// GetTask fetches one task by Todoist task id.
func (c *Client) GetTask(ctx context.Context, taskID string) (*Task, error) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return nil, fmt.Errorf("task id is required")
	}

	var task Task
	if err := c.doJSON(ctx, http.MethodGet, todoistTasksPath+"/"+taskID, nil, "", &task); err != nil {
		return nil, err
	}
	return &task, nil
}

// ListActiveTasks lists active (not completed) tasks.
func (c *Client) ListActiveTasks(ctx context.Context) ([]*Task, error) {
	allTasks := make([]*Task, 0)
	cursor := ""
	for {
		path := todoistTasksPath
		if cursor != "" {
			path += "?cursor=" + url.QueryEscape(cursor)
		}

		body, err := c.doRequest(ctx, http.MethodGet, path, nil, "")
		if err != nil {
			return nil, err
		}

		pageTasks, nextCursor, parseErr := parseTaskPage(body)
		if parseErr != nil {
			return nil, parseErr
		}
		allTasks = append(allTasks, pageTasks...)
		if nextCursor == "" {
			break
		}
		cursor = nextCursor
	}
	return allTasks, nil
}

// UpdateTask updates one task.
func (c *Client) UpdateTask(
	ctx context.Context,
	taskID string,
	requestID string,
	update *UpdateTaskRequest,
) (*Task, error) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return nil, fmt.Errorf("task id is required")
	}
	if update == nil {
		return nil, fmt.Errorf("update request is required")
	}

	var task Task
	if err := c.doJSON(ctx, http.MethodPost, todoistTasksPath+"/"+taskID, update, requestID, &task); err != nil {
		return nil, err
	}
	// Keep compatibility with APIs that return 204/empty body for updates.
	if strings.TrimSpace(task.ID) == "" {
		return c.GetTask(ctx, taskID)
	}
	return &task, nil
}

// UpdateTaskContent updates one task content.
func (c *Client) UpdateTaskContent(ctx context.Context, taskID string, content string) (*Task, error) {
	req := &UpdateTaskRequest{Content: strings.TrimSpace(content)}
	return c.UpdateTask(ctx, taskID, "", req)
}

// UpdateTaskLabels applies add/remove label diff and writes only when needed.
func (c *Client) UpdateTaskLabels(
	ctx context.Context,
	taskID string,
	addLabels []string,
	removeLabels []string,
) (*Task, error) {
	task, err := c.GetTask(ctx, taskID)
	if err != nil {
		return nil, err
	}

	updatedLabels := applyLabelDiff(task.Labels, addLabels, removeLabels)
	if stringSlicesEqual(task.Labels, updatedLabels) {
		return task, nil
	}

	return c.UpdateTask(ctx, taskID, "", &UpdateTaskRequest{Labels: updatedLabels})
}

// ListLabels lists all Todoist labels.
func (c *Client) ListLabels(ctx context.Context) ([]*Label, error) {
	allLabels := make([]*Label, 0)
	cursor := ""
	for {
		path := todoistLabelsPath
		if cursor != "" {
			path += "?cursor=" + url.QueryEscape(cursor)
		}

		body, err := c.doRequest(ctx, http.MethodGet, path, nil, "")
		if err != nil {
			return nil, err
		}

		pageLabels, nextCursor, parseErr := parseLabelPage(body)
		if parseErr != nil {
			return nil, parseErr
		}
		allLabels = append(allLabels, pageLabels...)
		if nextCursor == "" {
			break
		}
		cursor = nextCursor
	}
	return allLabels, nil
}

// CreateLabel creates one Todoist label.
func (c *Client) CreateLabel(ctx context.Context, name string) (*Label, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("label name is required")
	}

	var label Label
	if err := c.doJSON(
		ctx,
		http.MethodPost,
		todoistLabelsPath,
		&createLabelRequest{Name: name},
		"",
		&label,
	); err != nil {
		return nil, err
	}
	return &label, nil
}

// EnsureLabels ensures all labels exist and reports partial failures.
func (c *Client) EnsureLabels(ctx context.Context, labels []string) (*EnsureLabelsResult, error) {
	required := trimDedupeLabels(labels)
	result := &EnsureLabelsResult{
		Failures: make(map[string]string),
	}
	if len(required) == 0 {
		return result, nil
	}

	existingLabels, err := c.ListLabels(ctx)
	if err != nil {
		return nil, err
	}

	existingByName := make(map[string]struct{}, len(existingLabels))
	for _, label := range existingLabels {
		if label == nil {
			continue
		}
		existingByName[label.Name] = struct{}{}
	}

	for _, name := range required {
		if _, exists := existingByName[name]; exists {
			result.ExistingLabels = append(result.ExistingLabels, name)
			continue
		}

		if _, err := c.CreateLabel(ctx, name); err != nil {
			result.Failures[name] = err.Error()
			continue
		}
		result.CreatedLabels = append(result.CreatedLabels, name)
		existingByName[name] = struct{}{}
	}

	sort.Strings(result.ExistingLabels)
	sort.Strings(result.CreatedLabels)
	return result, nil
}

// VerifyWebhook verifies Todoist webhook signature using HMAC-SHA256.
func (c *Client) VerifyWebhook(rawBody []byte, signature string, secret string) bool {
	signature = strings.TrimSpace(signature)
	secret = strings.TrimSpace(secret)
	if signature == "" || secret == "" {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	if _, err := mac.Write(rawBody); err != nil {
		return false
	}
	expectedStd := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if hmac.Equal([]byte(expectedStd), []byte(signature)) {
		return true
	}

	// Some webhook producers use URL-safe base64 encoding for the same digest.
	macURL := hmac.New(sha256.New, []byte(secret))
	if _, err := macURL.Write(rawBody); err != nil {
		return false
	}
	expectedURL := base64.URLEncoding.EncodeToString(macURL.Sum(nil))
	return hmac.Equal([]byte(expectedURL), []byte(signature))
}

// doJSON executes an HTTP call and decodes JSON into out when the body is present.
func (c *Client) doJSON(
	ctx context.Context,
	method string,
	path string,
	body any,
	requestID string,
	out any,
) error {
	bodyBytes, err := c.doRequest(ctx, method, path, body, requestID)
	if err != nil {
		return err
	}
	if out == nil || len(bodyBytes) == 0 {
		return nil
	}
	if err := json.Unmarshal(bodyBytes, out); err != nil {
		return fmt.Errorf("failed to decode successful response body: %w", err)
	}
	return nil
}

// doRequest executes a Todoist API request and returns the raw response body bytes.
func (c *Client) doRequest(
	ctx context.Context,
	method string,
	path string,
	body any,
	requestID string,
) ([]byte, error) {
	var reqBodyBytes []byte
	if body != nil {
		var err error
		reqBodyBytes, err = json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
		if strings.EqualFold(method, http.MethodPost) && len(reqBodyBytes) > todoistMaxPostBodyBytes {
			return nil, fmt.Errorf(
				"todoist request body too large: %d bytes exceeds %d-byte POST limit",
				len(reqBodyBytes),
				todoistMaxPostBodyBytes,
			)
		}
	}

	var responseBody []byte
	err := utils.Retry(
		ctx,
		c.retryConfig,
		func(_ int) error {
			bodyBytes, callErr := c.doRequestOnce(ctx, method, path, reqBodyBytes, requestID)
			if callErr != nil {
				return callErr
			}
			responseBody = bodyBytes
			return nil
		},
		func(err error, _ int) (bool, time.Duration) {
			return shouldRetryRequest(err)
		},
	)
	if err != nil {
		return nil, err
	}
	return responseBody, nil
}

func (c *Client) doRequestOnce(
	ctx context.Context,
	method string,
	path string,
	reqBodyBytes []byte,
	requestID string,
) ([]byte, error) {
	if c.requestLimiter != nil {
		allowed, retryAfter := c.requestLimiter.Reserve(time.Now())
		if !allowed {
			return nil, fmt.Errorf(
				"todoist client-side rate limit exceeded: max %d requests per %s; retry after %s",
				todoistRateLimitCount,
				todoistRateLimitWindow,
				retryAfter.Truncate(time.Millisecond),
			)
		}
	}

	var bodyReader io.Reader
	if len(reqBodyBytes) > 0 {
		bodyReader = bytes.NewReader(reqBodyBytes)
	}

	reqURL := c.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, reqURL, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(c.token))
	if len(reqBodyBytes) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	if requestID != "" {
		req.Header.Set("X-Request-Id", requestID)
	}
	if headerBytes := estimateHeaderBytes(req.Header); headerBytes > todoistMaxHeaderBytes {
		return nil, fmt.Errorf(
			"todoist request headers too large: %d bytes exceeds %d-byte limit",
			headerBytes,
			todoistMaxHeaderBytes,
		)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return nil, fmt.Errorf(
				"todoist request timed out before completion (client timeout %s, server limit 15s): %w",
				c.httpClient.Timeout,
				err,
			)
		}
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf(
				"todoist request context deadline exceeded (server processing timeout is 15s): %w",
				err,
			)
		}
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			log.Printf("Failed to close response body: %v", closeErr)
		}
	}()

	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, &todoistHTTPError{
			statusCode: resp.StatusCode,
			body:       string(bodyBytes),
			retryAfter: parseRetryAfter(resp.Header.Get("Retry-After"), time.Now()),
		}
	}

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read successful response body: %w", err)
	}
	return bodyBytes, nil
}

func shouldRetryRequest(err error) (bool, time.Duration) {
	var httpErr *todoistHTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.statusCode {
		case http.StatusTooManyRequests:
			if httpErr.retryAfter > 0 {
				return true, httpErr.retryAfter
			}
			return true, 0
		case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
			return true, 0
		default:
			return false, 0
		}
	}

	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true, 0
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true, 0
	}
	return false, 0
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}

	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds <= 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}

	if retryAt, err := http.ParseTime(value); err == nil {
		delay := retryAt.Sub(now)
		if delay <= 0 {
			return 0
		}
		return delay
	}
	return 0
}

func truncateForError(value string, limit int) string {
	if limit <= 0 || len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}

func estimateHeaderBytes(headers http.Header) int {
	total := 2 // final CRLF
	for key, values := range headers {
		for _, value := range values {
			total += len(key) + 2 + len(value) + 2 // "Key: Value\r\n"
		}
	}
	return total
}

func limiterForToken(token string) *utils.SlidingWindowLimiter {
	key := strings.TrimSpace(token)
	if key == "" {
		key = "<empty-token>"
	}

	tokenLimiterMu.Lock()
	defer tokenLimiterMu.Unlock()

	limiter, exists := tokenLimiters[key]
	if exists {
		return limiter
	}

	limiter = utils.NewSlidingWindowLimiter(todoistRateLimitCount, todoistRateLimitWindow)
	tokenLimiters[key] = limiter
	return limiter
}

// parseTaskPage supports both legacy array and paginated envelope task responses.
func parseTaskPage(body []byte) ([]*Task, string, error) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nil, "", nil
	}

	var pageTasks []*Task
	if err := json.Unmarshal(body, &pageTasks); err == nil {
		return pageTasks, "", nil
	}

	var envelope struct {
		Results    []*Task `json:"results"`
		NextCursor string  `json:"next_cursor"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, "", fmt.Errorf("failed to decode task list response: %w", err)
	}
	if !hasJSONField(body, "results") {
		return nil, "", fmt.Errorf("failed to decode task list response: missing results field")
	}
	return envelope.Results, envelope.NextCursor, nil
}

// parseLabelPage supports both legacy array and paginated envelope label responses.
func parseLabelPage(body []byte) ([]*Label, string, error) {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return nil, "", nil
	}

	var pageLabels []*Label
	if err := json.Unmarshal(body, &pageLabels); err == nil {
		return pageLabels, "", nil
	}

	var envelope struct {
		Results    []*Label `json:"results"`
		NextCursor string   `json:"next_cursor"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, "", fmt.Errorf("failed to decode label list response: %w", err)
	}
	if !hasJSONField(body, "results") {
		return nil, "", fmt.Errorf("failed to decode label list response: missing results field")
	}
	return envelope.Results, envelope.NextCursor, nil
}

// hasJSONField verifies that the decoded JSON object contains a named top-level field.
func hasJSONField(body []byte, field string) bool {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return false
	}
	_, ok := raw[field]
	return ok
}

// trimDedupeLabels removes empty labels while preserving first-seen order.
func trimDedupeLabels(labels []string) []string {
	out := make([]string, 0, len(labels))
	seen := make(map[string]struct{}, len(labels))
	for _, label := range labels {
		label = strings.TrimSpace(label)
		if label == "" {
			continue
		}
		if _, exists := seen[label]; exists {
			continue
		}
		seen[label] = struct{}{}
		out = append(out, label)
	}
	return out
}

// applyLabelDiff computes the next label set from add/remove operations.
func applyLabelDiff(currentLabels []string, addLabels []string, removeLabels []string) []string {
	labelSet := make(map[string]struct{}, len(currentLabels))
	for _, label := range currentLabels {
		label = strings.TrimSpace(label)
		if label == "" {
			continue
		}
		labelSet[label] = struct{}{}
	}

	for _, label := range addLabels {
		label = strings.TrimSpace(label)
		if label == "" {
			continue
		}
		labelSet[label] = struct{}{}
	}

	for _, label := range removeLabels {
		delete(labelSet, strings.TrimSpace(label))
	}

	out := make([]string, 0, len(labelSet))
	for label := range labelSet {
		out = append(out, label)
	}
	sort.Strings(out)
	return out
}

// stringSlicesEqual compares two string slices as sets with deterministic sorting.
func stringSlicesEqual(a []string, b []string) bool {
	if len(a) != len(b) {
		return false
	}

	aCopy := append([]string(nil), a...)
	bCopy := append([]string(nil), b...)
	sort.Strings(aCopy)
	sort.Strings(bCopy)
	for i := range aCopy {
		if aCopy[i] != bCopy[i] {
			return false
		}
	}
	return true
}
