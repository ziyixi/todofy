package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	pb "github.com/ziyixi/protos/go/todofy"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type fakeStartupClients struct {
	waitErr     error
	setDBErr    error
	serviceList []string
	closed      bool
	setupPath   string
}

func (f *fakeStartupClients) Close() {
	f.closed = true
}

func (f *fakeStartupClients) WaitForHealthy(_ context.Context) error {
	return f.waitErr
}

func (f *fakeStartupClients) SetUpDataBase(path string) error {
	f.setupPath = path
	return f.setDBErr
}

func (f *fakeStartupClients) ServiceNames() []string {
	return f.serviceList
}

type fakeAppRunner struct {
	runErr error
	addrs  []string
}

func (f *fakeAppRunner) Run(addr ...string) error {
	f.addrs = append(f.addrs, addr...)
	return f.runErr
}

func TestInitLogger(t *testing.T) {
	initLogger()

	formatter, ok := log.Formatter.(*logrus.TextFormatter)
	require.True(t, ok)
	assert.True(t, formatter.FullTimestamp)
}

func TestInitFlags_UsesCommandLineFlagSet(t *testing.T) {
	originalCommandLine := flag.CommandLine
	originalConfig := config
	t.Cleanup(func() {
		flag.CommandLine = originalCommandLine
		config = originalConfig
	})

	flag.CommandLine = flag.NewFlagSet("todofy-test", flag.ContinueOnError)
	config = Config{}
	initFlags()

	err := flag.CommandLine.Parse([]string{
		"-allowed-users", "alice:secret",
		"-database-path", "/tmp/todofy.db",
		"-port", "19090",
		"-health-check-timeout", "5",
		"-llm-addr", "localhost:60051",
		"-todo-addr", "localhost:60052",
		"-dependency-addr", "localhost:60054",
		"-todoist-addr", "localhost:60055",
		"-database-addr", "localhost:60053",
	})
	require.NoError(t, err)

	assert.Equal(t, "alice:secret", config.AllowedUsers)
	assert.Equal(t, "/tmp/todofy.db", config.DataBasePath)
	assert.Equal(t, 19090, config.Port)
	assert.Equal(t, 5, config.HealthCheckTimeout)
	assert.Equal(t, "localhost:60051", config.LLMAddr)
	assert.Equal(t, "localhost:60052", config.TodoAddr)
	assert.Equal(t, "localhost:60054", config.DependencyAddr)
	assert.Equal(t, "localhost:60055", config.TodoistAddr)
	assert.Equal(t, "localhost:60053", config.DatabaseAddr)
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
	assert.Equal(t, "", cfg.DependencyAddr)
	assert.Equal(t, "", cfg.TodoistAddr)
	assert.Equal(t, ":50053", cfg.DatabaseAddr)
}

func TestBuildServiceConfigs(t *testing.T) {
	cfg := Config{
		LLMAddr:        "llm:50051",
		TodoAddr:       "todo:50052",
		DependencyAddr: "dependency:50054",
		TodoistAddr:    "todoist:50055",
		DatabaseAddr:   "database:50053",
	}
	serviceConfigs := buildServiceConfigs(cfg)
	require.Len(t, serviceConfigs, 5)
	assert.Equal(t, "llm", serviceConfigs[0].name)
	assert.Equal(t, "llm:50051", serviceConfigs[0].addr)
	assert.Equal(t, "todo", serviceConfigs[1].name)
	assert.Equal(t, "todo:50052", serviceConfigs[1].addr)
	assert.Equal(t, "database", serviceConfigs[2].name)
	assert.Equal(t, "database:50053", serviceConfigs[2].addr)
	assert.Equal(t, "dependency", serviceConfigs[3].name)
	assert.Equal(t, "dependency:50054", serviceConfigs[3].addr)
	assert.Equal(t, "todoist", serviceConfigs[4].name)
	assert.Equal(t, "todoist:50055", serviceConfigs[4].addr)

	conn, err := grpc.NewClient(
		"passthrough:///build-service-config-test",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = conn.Close()
	})

	_, ok := serviceConfigs[0].newClient(conn).(pb.LLMSummaryServiceClient)
	assert.True(t, ok)
	_, ok = serviceConfigs[1].newClient(conn).(pb.TodoServiceClient)
	assert.True(t, ok)
	_, ok = serviceConfigs[2].newClient(conn).(pb.DataBaseServiceClient)
	assert.True(t, ok)
	_, ok = serviceConfigs[3].newClient(conn).(pb.DependencyServiceClient)
	assert.True(t, ok)
	_, ok = serviceConfigs[4].newClient(conn).(pb.TodoistServiceClient)
	assert.True(t, ok)
}

func TestSetupGRPCClients_UsesBuilderAndFactory(t *testing.T) {
	original := newGRPCClientsFunc
	t.Cleanup(func() { newGRPCClientsFunc = original })

	var captured []ServiceConfig
	newGRPCClientsFunc = func(configs []ServiceConfig) (*GRPCClients, error) {
		captured = configs
		return &GRPCClients{services: map[string]*serviceState{}}, nil
	}

	cfg := Config{
		LLMAddr:        "llm:1111",
		TodoAddr:       "todo:2222",
		DependencyAddr: "dep:4444",
		TodoistAddr:    "todoist:5555",
		DatabaseAddr:   "db:3333",
	}
	clients, err := setupGRPCClients(cfg)
	require.NoError(t, err)
	require.NotNil(t, clients)
	require.Len(t, captured, 5)
	assert.Equal(t, "llm:1111", captured[0].addr)
	assert.Equal(t, "todo:2222", captured[1].addr)
	assert.Equal(t, "db:3333", captured[2].addr)
	assert.Equal(t, "dep:4444", captured[3].addr)
	assert.Equal(t, "todoist:5555", captured[4].addr)

	t.Run("returns wrapped error when factory fails", func(t *testing.T) {
		newGRPCClientsFunc = func([]ServiceConfig) (*GRPCClients, error) {
			return nil, errors.New("factory failed")
		}
		_, err := setupGRPCClients(cfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to create gRPC clients")
	})
}

func TestRun(t *testing.T) {
	originalCreateClients := createClients
	originalCreateRouter := createRouter
	t.Cleanup(func() {
		createClients = originalCreateClients
		createRouter = originalCreateRouter
	})

	baseCfg := Config{
		AllowedUsers:       "user:pass",
		DataBasePath:       "/tmp/test.db",
		Port:               12345,
		HealthCheckTimeout: 1,
	}

	t.Run("defaults dependency and todoist addr to todo addr when omitted", func(t *testing.T) {
		capturedCfg := Config{}
		fakeClients := &fakeStartupClients{serviceList: []string{"database"}}
		fakeRunner := &fakeAppRunner{}
		createClients = func(cfg Config) (startupClients, error) {
			capturedCfg = cfg
			return fakeClients, nil
		}
		createRouter = func(gin.Accounts, startupClients) (appRunner, error) {
			return fakeRunner, nil
		}

		cfg := baseCfg
		cfg.TodoAddr = "todo:2222"
		cfg.DependencyAddr = ""
		cfg.TodoistAddr = ""

		err := run(cfg)
		require.NoError(t, err)
		assert.Equal(t, "todo:2222", capturedCfg.DependencyAddr)
		assert.Equal(t, "todo:2222", capturedCfg.TodoistAddr)
	})

	t.Run("errors when allowed users are missing", func(t *testing.T) {
		err := run(Config{})
		require.Error(t, err)
		assert.Contains(t, err.Error(), "no allowed users provided")
	})

	t.Run("propagates client creation errors", func(t *testing.T) {
		createClients = func(Config) (startupClients, error) {
			return nil, errors.New("create failed")
		}
		err := run(baseCfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to create gRPC clients")
	})

	t.Run("propagates health check errors", func(t *testing.T) {
		fakeClients := &fakeStartupClients{waitErr: errors.New("unhealthy")}
		createClients = func(Config) (startupClients, error) {
			return fakeClients, nil
		}
		err := run(baseCfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to connect to gRPC services")
		assert.True(t, fakeClients.closed)
	})

	t.Run("errors when database path missing", func(t *testing.T) {
		fakeClients := &fakeStartupClients{}
		createClients = func(Config) (startupClients, error) {
			return fakeClients, nil
		}

		cfg := baseCfg
		cfg.DataBasePath = ""
		err := run(cfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "no database path provided")
	})

	t.Run("propagates setup database errors", func(t *testing.T) {
		fakeClients := &fakeStartupClients{setDBErr: errors.New("db setup failed")}
		createClients = func(Config) (startupClients, error) {
			return fakeClients, nil
		}
		err := run(baseCfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to set up database")
	})

	t.Run("errors when allowed users are invalid", func(t *testing.T) {
		fakeClients := &fakeStartupClients{}
		createClients = func(Config) (startupClients, error) {
			return fakeClients, nil
		}

		cfg := baseCfg
		cfg.AllowedUsers = "not-valid"
		err := run(cfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "invalid user format")
	})

	t.Run("propagates router creation errors", func(t *testing.T) {
		fakeClients := &fakeStartupClients{}
		createClients = func(Config) (startupClients, error) {
			return fakeClients, nil
		}
		createRouter = func(gin.Accounts, startupClients) (appRunner, error) {
			return nil, errors.New("router build failed")
		}

		err := run(baseCfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to create router")
	})

	t.Run("propagates server run errors", func(t *testing.T) {
		fakeClients := &fakeStartupClients{serviceList: []string{"llm", "todo", "database"}}
		fakeRunner := &fakeAppRunner{runErr: errors.New("bind failed")}
		createClients = func(Config) (startupClients, error) {
			return fakeClients, nil
		}
		createRouter = func(gin.Accounts, startupClients) (appRunner, error) {
			return fakeRunner, nil
		}

		err := run(baseCfg)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "failed to start server")
		assert.Equal(t, []string{":12345"}, fakeRunner.addrs)
		assert.Equal(t, "/tmp/test.db", fakeClients.setupPath)
	})

	t.Run("returns nil on successful startup", func(t *testing.T) {
		fakeClients := &fakeStartupClients{serviceList: []string{"database"}}
		fakeRunner := &fakeAppRunner{}
		createClients = func(Config) (startupClients, error) {
			return fakeClients, nil
		}
		createRouter = func(gin.Accounts, startupClients) (appRunner, error) {
			return fakeRunner, nil
		}

		err := run(baseCfg)
		require.NoError(t, err)
		assert.True(t, fakeClients.closed)
		assert.Equal(t, []string{":12345"}, fakeRunner.addrs)
	})
}

func TestMain_ParsesFlagsAndCallsRun(t *testing.T) {
	originalRunApplication := runApplication
	originalCommandLine := flag.CommandLine
	originalArgs := os.Args
	originalConfig := config
	t.Cleanup(func() {
		runApplication = originalRunApplication
		flag.CommandLine = originalCommandLine
		os.Args = originalArgs
		config = originalConfig
	})

	flag.CommandLine = flag.NewFlagSet("todofy-main-test", flag.ContinueOnError)
	os.Args = []string{
		"todofy",
		"-allowed-users", "user:pass",
		"-database-path", "/tmp/todofy.db",
		"-port", "19091",
	}

	called := false
	runApplication = func(cfg Config) error {
		called = true
		assert.Equal(t, "user:pass", cfg.AllowedUsers)
		assert.Equal(t, "/tmp/todofy.db", cfg.DataBasePath)
		assert.Equal(t, 19091, cfg.Port)
		return nil
	}

	main()
	assert.True(t, called)
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

	t.Run("todoist webhook route is public", func(t *testing.T) {
		w := httptest.NewRecorder()
		req, _ := http.NewRequest(http.MethodPost, "/api/v1/todoist/webhook", nil)
		router.ServeHTTP(w, req)
		assert.NotEqual(t, http.StatusUnauthorized, w.Code)
	})
}
