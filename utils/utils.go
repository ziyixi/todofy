package utils

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/go-resty/resty/v2"
)

// ParseAllowedUsers parses a comma-separated list of allowed users in the format "username:password"
func ParseAllowedUsers(users string) (map[string]string, string) {
	parsedUsers := make(map[string]string)
	parsedUserStrings := ""
	for _, user := range strings.Split(users, ",") {
		parts := strings.Split(user, ":")
		if len(parts) != 2 {
			log.Fatalf("Invalid user format: %s. Expected 'username:password'", user)
		}
		parsedUsers[parts[0]] = parts[1]
		parsedUserStrings += fmt.Sprintf("%s:%s, ", parts[0], "<hidden>")
	}
	parsedUserStrings = strings.TrimSuffix(parsedUserStrings, ", ")
	return parsedUsers, parsedUserStrings
}

// FetchWithBasicAuth makes an HTTP GET request with Basic Auth and returns a dynamic JSON structure
func FetchWithBasicAuth(url, username, password string) (interface{}, error) {
	client := resty.New()

	// Make the request with Basic Auth
	resp, err := client.R().
		SetBasicAuth(username, password).
		Get(url)

	if err != nil {
		return nil, fmt.Errorf("error making HTTP request to %s: %w", url, err)
	}

	// Create a variable to hold the dynamic JSON response
	var result interface{}

	// Unmarshal the response body into the dynamic structure
	err = json.Unmarshal(resp.Body(), &result)
	if err != nil {
		return nil, fmt.Errorf("error unmarshalling JSON: %w", err)
	}

	// Return the parsed JSON as a generic interface{}
	return result, nil
}

// RateLimitMiddleware is a middleware that limits the number of requests per minute
func RateLimitMiddleware() gin.HandlerFunc {
	// Declare variables inside the closure
	var mu sync.Mutex
	requestsCount := 0
	resetTime := time.Now().Add(1 * time.Minute)

	return func(c *gin.Context) {
		mu.Lock()
		defer mu.Unlock()

		// Check if the time window has expired
		if time.Now().After(resetTime) {
			// Reset the counter and the time window
			requestsCount = 0
			resetTime = time.Now().Add(1 * time.Minute)
		}

		// Check the request count
		if requestsCount >= 2 {
			// Block the request if the limit is reached
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "Too many requests. Please wait for the next minute.",
			})
			c.Abort()
			return
		}

		// Allow the request and increment the counter
		requestsCount++

		// Process the request
		c.Next()
	}
}
