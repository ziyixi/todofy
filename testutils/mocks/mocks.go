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
	args := m.Called(name)
	if client, ok := m.clients[name]; ok {
		return client
	}
	return args.Get(0)
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

// MockMailjetClient is a mock implementation for Mailjet client
type MockMailjetClient struct {
	mock.Mock
}

// SendEmail sends an email using the mock Mailjet client
func (m *MockMailjetClient) SendEmail(to, from, subject, body string) (interface{}, error) {
	args := m.Called(to, from, subject, body)
	return args.Get(0), args.Error(1)
}

// MockNotionClient is a mock implementation for Notion client
type MockNotionClient struct {
	mock.Mock
}

// CreatePage creates a page in Notion using the mock client
func (m *MockNotionClient) CreatePage(
	ctx context.Context,
	databaseID string,
	properties interface{},
) (interface{}, error) {
	args := m.Called(ctx, databaseID, properties)
	return args.Get(0), args.Error(1)
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
