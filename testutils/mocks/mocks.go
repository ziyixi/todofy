// Package mocks provides mock implementations for testing
package mocks

import (
	"context"

	"github.com/stretchr/testify/mock"
	pb "github.com/ziyixi/protos/go/todofy"
	"google.golang.org/grpc"
)

// MockLLMSummaryServiceClient is a mock implementation of LLMSummaryServiceClient
type MockLLMSummaryServiceClient struct {
	mock.Mock
}

// Summarize generates a summary using the mock LLM service
func (m *MockLLMSummaryServiceClient) Summarize(
	ctx context.Context,
	in *pb.LLMSummaryRequest,
	opts ...grpc.CallOption,
) (*pb.LLMSummaryResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.LLMSummaryResponse), args.Error(1)
}

// MockTodoServiceClient is a mock implementation of TodoServiceClient
type MockTodoServiceClient struct {
	mock.Mock
}

// PopulateTodo creates or populates a todo using the mock service
func (m *MockTodoServiceClient) PopulateTodo(
	ctx context.Context,
	in *pb.TodoRequest,
	opts ...grpc.CallOption,
) (*pb.TodoResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.TodoResponse), args.Error(1)
}

// MockDataBaseServiceClient is a mock implementation of DataBaseServiceClient
type MockDataBaseServiceClient struct {
	mock.Mock
}

// CreateIfNotExist creates a database if it doesn't exist using the mock service
func (m *MockDataBaseServiceClient) CreateIfNotExist(
	ctx context.Context,
	in *pb.CreateIfNotExistRequest,
	opts ...grpc.CallOption,
) (*pb.CreateIfNotExistResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.CreateIfNotExistResponse), args.Error(1)
}

func (m *MockDataBaseServiceClient) Write(ctx context.Context, in *pb.WriteRequest,
	opts ...grpc.CallOption) (*pb.WriteResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.WriteResponse), args.Error(1)
}

// CheckExist checks whether an entry with the given hash_id exists
func (m *MockDataBaseServiceClient) CheckExist(
	ctx context.Context,
	in *pb.CheckExistRequest,
	opts ...grpc.CallOption,
) (*pb.CheckExistResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.CheckExistResponse), args.Error(1)
}

// QueryRecent retrieves recent database entries using the mock service
func (m *MockDataBaseServiceClient) QueryRecent(
	ctx context.Context,
	in *pb.QueryRecentRequest,
	opts ...grpc.CallOption,
) (*pb.QueryRecentResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.QueryRecentResponse), args.Error(1)
}

// MockDependencyServiceClient is a mock implementation of DependencyServiceClient.
type MockDependencyServiceClient struct {
	mock.Mock
}

// ReconcileGraph mocks dependency graph reconcile calls.
func (m *MockDependencyServiceClient) ReconcileGraph(
	ctx context.Context,
	in *pb.ReconcileDependencyGraphRequest,
	opts ...grpc.CallOption,
) (*pb.ReconcileDependencyGraphResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.ReconcileDependencyGraphResponse), args.Error(1)
}

// AnalyzeGraph mocks dependency graph analyze calls.
func (m *MockDependencyServiceClient) AnalyzeGraph(
	ctx context.Context,
	in *pb.AnalyzeDependencyGraphRequest,
	opts ...grpc.CallOption,
) (*pb.AnalyzeDependencyGraphResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.AnalyzeDependencyGraphResponse), args.Error(1)
}

// BootstrapMissingTaskKeys mocks key bootstrap calls.
func (m *MockDependencyServiceClient) BootstrapMissingTaskKeys(
	ctx context.Context,
	in *pb.BootstrapMissingTaskKeysRequest,
	opts ...grpc.CallOption,
) (*pb.BootstrapMissingTaskKeysResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.BootstrapMissingTaskKeysResponse), args.Error(1)
}

// ClearDependencyMetadata mocks dependency metadata clear calls.
func (m *MockDependencyServiceClient) ClearDependencyMetadata(
	ctx context.Context,
	in *pb.ClearDependencyMetadataRequest,
	opts ...grpc.CallOption,
) (*pb.ClearDependencyMetadataResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.ClearDependencyMetadataResponse), args.Error(1)
}

// GetTaskStatus mocks task dependency status lookups.
func (m *MockDependencyServiceClient) GetTaskStatus(
	ctx context.Context,
	in *pb.GetTaskDependencyStatusRequest,
	opts ...grpc.CallOption,
) (*pb.GetTaskDependencyStatusResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.GetTaskDependencyStatusResponse), args.Error(1)
}

// ListDependencyIssues mocks dependency issue list calls.
func (m *MockDependencyServiceClient) ListDependencyIssues(
	ctx context.Context,
	in *pb.ListDependencyIssuesRequest,
	opts ...grpc.CallOption,
) (*pb.ListDependencyIssuesResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.ListDependencyIssuesResponse), args.Error(1)
}

// MarkGraphDirty mocks compatibility hint calls.
func (m *MockDependencyServiceClient) MarkGraphDirty(
	ctx context.Context,
	in *pb.MarkDependencyGraphDirtyRequest,
	opts ...grpc.CallOption,
) (*pb.MarkDependencyGraphDirtyResponse, error) {
	args := m.Called(ctx, in, opts)
	if args.Get(0) == nil {
		return nil, args.Error(1)
	}
	return args.Get(0).(*pb.MarkDependencyGraphDirtyResponse), args.Error(1)
}

// MockGRPCClients is a mock implementation of GRPCClients
type MockGRPCClients struct {
	mock.Mock
	clients map[string]interface{}
}

// NewMockGRPCClients creates a new mock gRPC clients container for testing
func NewMockGRPCClients() *MockGRPCClients {
	return &MockGRPCClients{
		clients: make(map[string]interface{}),
	}
}

// GetClient retrieves a mock client by name
func (m *MockGRPCClients) GetClient(name string) interface{} {
	if client, ok := m.clients[name]; ok {
		return client
	}
	return nil
}

// SetClient sets a mock client by name for testing
func (m *MockGRPCClients) SetClient(name string, client interface{}) {
	m.clients[name] = client
}

// Close closes all mock gRPC client connections
func (m *MockGRPCClients) Close() {
	m.Called()
}

// MockHTTPClient is a mock implementation for HTTP client operations
type MockHTTPClient struct {
	mock.Mock
}

// Get performs a mock HTTP GET request
func (m *MockHTTPClient) Get(url string) (interface{}, error) {
	args := m.Called(url)
	return args.Get(0), args.Error(1)
}

// Post performs a mock HTTP POST request
func (m *MockHTTPClient) Post(url string, body interface{}) (interface{}, error) {
	args := m.Called(url, body)
	return args.Get(0), args.Error(1)
}

// MockGeminiClient is a mock implementation for Gemini client
type MockGeminiClient struct {
	mock.Mock
}

// GenerateContent generates content using the mock Gemini AI client
func (m *MockGeminiClient) GenerateContent(ctx context.Context, model string, content interface{}) (string, error) {
	args := m.Called(ctx, model, content)
	return args.String(0), args.Error(1)
}

// MockTodoistClient is a mock implementation for Todoist client
type MockTodoistClient struct {
	mock.Mock
}

// CreateTask creates a task in Todoist using the mock client
func (m *MockTodoistClient) CreateTask(ctx context.Context, requestID string, task interface{}) (interface{}, error) {
	args := m.Called(ctx, requestID, task)
	return args.Get(0), args.Error(1)
}
