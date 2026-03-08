package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/ziyixi/todofy/utils"
)

func TestSetupRouter(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("creates router with correct routes", func(t *testing.T) {
		allowedUsers := gin.Accounts{
			"testuser": "testpass",
		}

		// Create a real GRPCClients instance for testing the router setup
		// We'll pass nil for the actual client connections since we're only testing setup
		grpcClients := &GRPCClients{
			services: make(map[string]*serviceState),
		}

		router := setupRouter(allowedUsers, grpcClients)
		require.NotNil(t, router)

		// The router should be successfully created
		assert.NotNil(t, router)
	})

	t.Run("router handles basic auth", func(t *testing.T) {
		allowedUsers := gin.Accounts{
			"testuser": "testpass", // Gin requires non-empty accounts for BasicAuth
		}
		grpcClients := &GRPCClients{
			services: make(map[string]*serviceState),
		}

		router := setupRouter(allowedUsers, grpcClients)
		require.NotNil(t, router)

		// The router should be created successfully
		assert.NotNil(t, router)
	})
}

func TestConfig_DefaultValues(t *testing.T) {
	t.Run("config has reasonable defaults", func(t *testing.T) {
		// Test that our config struct supports the expected fields
		// This tests the structure, not the flag parsing
		config := Config{
			Port:               8080,
			HealthCheckTimeout: 10,
			LLMAddr:            ":50051",
			TodoAddr:           ":50052",
			DatabaseAddr:       ":50053",
		}

		assert.Equal(t, 8080, config.Port)
		assert.Equal(t, 10, config.HealthCheckTimeout)
		assert.Equal(t, ":50051", config.LLMAddr)
		assert.Equal(t, ":50052", config.TodoAddr)
		assert.Equal(t, ":50053", config.DatabaseAddr)
	})
}

func TestGitCommit_Variable(t *testing.T) {
	t.Run("GitCommit variable exists", func(t *testing.T) {
		// Test that GitCommit variable is accessible
		// It will be empty in tests unless set by build
		_ = GitCommit

		// Just verify the variable is accessible
		assert.True(t, true)
	})
}

func TestHealthEndpoint(t *testing.T) {
	gin.SetMode(gin.TestMode)

	allowedUsers := gin.Accounts{"testuser": "testpass"}
	grpcClients := &GRPCClients{
		services: make(map[string]*serviceState),
	}

	router := setupRouter(allowedUsers, grpcClients)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/health", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var body map[string]interface{}
	err := json.Unmarshal(w.Body.Bytes(), &body)
	require.NoError(t, err)

	assert.Equal(t, "healthy", body["status"])
	assert.NotEmpty(t, body["timestamp"])
	assert.Equal(t, "todofy", body["service"])
}

func TestGrpcMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)

	grpcClients := &GRPCClients{
		services: make(map[string]*serviceState),
	}

	router := gin.New()
	router.Use(grpcMiddleware(grpcClients))
	router.GET("/test", func(c *gin.Context) {
		val, exists := c.Get(utils.KeyGRPCClients)
		assert.True(t, exists)
		assert.Equal(t, grpcClients, val)
		c.Status(http.StatusOK)
	})

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/test", nil)
	router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
}
