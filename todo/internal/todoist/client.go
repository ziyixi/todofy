// Package todoist provides a client for interacting with the Todoist API.
// It supports creating tasks and managing todo items through HTTP requests.
package todoist

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

const (
	// defaultTimeout specifies the default timeout for HTTP requests.
	defaultTimeout = 10 * time.Second
	// defaultBaseURL is the base URL for the Todoist API v1.
	defaultBaseURL = "https://api.todoist.com/api/v1"
)

// Client is a client for interacting with the Todoist API v1.
type Client struct {
	httpClient *http.Client
	token      string
	baseURL    string
}

// NewClient creates and returns a new Todoist API client.
// It requires an API token for authentication.
func NewClient(token string) *Client {
	return &Client{
		httpClient: &http.Client{
			Timeout: defaultTimeout,
		},
		token:   token,
		baseURL: defaultBaseURL,
	}
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

// CreateTask sends a request to the Todoist API to create a new task.
// It requires a context for managing the request lifecycle and a requestID
// for idempotency. The taskDetails struct contains the payload for the new task.
func (c *Client) CreateTask(ctx context.Context, requestID string, taskDetails *CreateTaskRequest) (*Task, error) {
	// Step 1: Marshal the request body from the Go struct to a JSON byte slice.
	reqBodyBytes, err := json.Marshal(taskDetails)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	// The endpoint URL is constructed from the base URL.
	url := fmt.Sprintf("%s/tasks", c.baseURL)

	// Step 2: Create a new HTTP request object with the context.
	// Using NewRequestWithContext ensures the request respects context cancellation.
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(reqBodyBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Step 3: Set the necessary HTTP headers.
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.token)
	if requestID != "" {
		req.Header.Set("X-Request-Id", requestID)
	}

	// Step 4: Execute the request using the configured http.Client.
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer func() {
		if err := resp.Body.Close(); err != nil {
			log.Printf("Failed to close response body: %v", err)
		}
	}()

	// Step 5: Handle the response. Check for non-successful status codes.
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("received non-2xx response status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	// Step 6: Decode the successful JSON response into the Task struct.
	var createdTask Task
	if err := json.NewDecoder(resp.Body).Decode(&createdTask); err != nil {
		return nil, fmt.Errorf("failed to decode successful response body: %w", err)
	}

	return &createdTask, nil
}
