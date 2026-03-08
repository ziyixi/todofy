package main

import (
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInitLogger(t *testing.T) {
	initLogger()

	formatter, ok := log.Formatter.(*logrus.TextFormatter)
	require.True(t, ok)
	assert.True(t, formatter.FullTimestamp)
}

func TestInitFlagsWithFlagSet_Defaults(t *testing.T) {
	cfg := Config{}
	fs := flag.NewFlagSet("test-default", flag.ContinueOnError)
	initFlagsWithFlagSet(fs, &cfg)

	require.NoError(t, fs.Parse([]string{}))
	assert.Equal(t, "", cfg.AllowedUsers)
	assert.Equal(t, "", cfg.DataBasePath)
	assert.Equal(t, 8080, cfg.Port)
	assert.Equal(t, 10, cfg.HealthCheckTimeout)
	assert.Equal(t, ":50051", cfg.LLMAddr)
	assert.Equal(t, ":50052", cfg.TodoAddr)
	assert.Equal(t, ":50053", cfg.DatabaseAddr)
}

func TestInitFlagsWithFlagSet_CustomValues(t *testing.T) {
	cfg := Config{}
	fs := flag.NewFlagSet("test-custom", flag.ContinueOnError)
	initFlagsWithFlagSet(fs, &cfg)

	args := []string{
		"-allowed-users", "alice:secret",
		"-database-path", "/tmp/todofy.db",
		"-port", "19090",
		"-health-check-timeout", "5",
		"-llm-addr", "localhost:60051",
		"-todo-addr", "localhost:60052",
		"-database-addr", "localhost:60053",
	}

	require.NoError(t, fs.Parse(args))
	assert.Equal(t, "alice:secret", cfg.AllowedUsers)
	assert.Equal(t, "/tmp/todofy.db", cfg.DataBasePath)
	assert.Equal(t, 19090, cfg.Port)
	assert.Equal(t, 5, cfg.HealthCheckTimeout)
	assert.Equal(t, "localhost:60051", cfg.LLMAddr)
	assert.Equal(t, "localhost:60052", cfg.TodoAddr)
	assert.Equal(t, "localhost:60053", cfg.DatabaseAddr)
}

func TestBuildServiceConfigs(t *testing.T) {
	cfg := Config{
		LLMAddr:      "llm:50051",
		TodoAddr:     "todo:50052",
		DatabaseAddr: "database:50053",
	}

	serviceConfigs := buildServiceConfigs(cfg)
	require.Len(t, serviceConfigs, 3)
	assert.Equal(t, "llm", serviceConfigs[0].name)
	assert.Equal(t, "llm:50051", serviceConfigs[0].addr)
	assert.Equal(t, "todo", serviceConfigs[1].name)
	assert.Equal(t, "todo:50052", serviceConfigs[1].addr)
	assert.Equal(t, "database", serviceConfigs[2].name)
	assert.Equal(t, "database:50053", serviceConfigs[2].addr)
}

func TestSetupRouter(t *testing.T) {
	gin.SetMode(gin.TestMode)

	allowedUsers := gin.Accounts{"testuser": "testpass"}
	grpcClients := &GRPCClients{services: map[string]*serviceState{}}
	router := setupRouter(allowedUsers, grpcClients)
	require.NotNil(t, router)

	t.Run("health endpoint responds without auth", func(t *testing.T) {
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodGet, "/health", nil)
		router.ServeHTTP(w, req)

		assert.Equal(t, http.StatusOK, w.Code)
		var body map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
		assert.Equal(t, "healthy", body["status"])
		assert.NotEmpty(t, body["timestamp"])
		assert.Equal(t, "todofy", body["service"])
	})

	t.Run("api routes require basic auth", func(t *testing.T) {
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodGet, "/api/summary", nil)
		router.ServeHTTP(w, req)
		assert.Equal(t, http.StatusUnauthorized, w.Code)
	})
}
