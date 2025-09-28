package main

import (
	"context"
	"flag"
	"fmt"
	"slices"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/genai"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/ziyixi/protos/go/todofy"
)

var log = logrus.New()
var GitCommit string // Will be set by Bazel at build time

// initLogger initializes the logger configuration
func initLogger() {
	log.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})
}

var (
	port         = flag.Int("port", 50051, "The server port of the LLM service")
	geminiAPIKey = flag.String("gemini-api-key", "", "The API key for Gemini")
)

type llmServer struct {
	pb.LLMSummaryServiceServer
}

func (s *llmServer) Summarize(ctx context.Context, req *pb.LLMSummaryRequest) (*pb.LLMSummaryResponse, error) {
	if !slices.Contains(supportedModelFamily, req.ModelFamily) {
		return nil, status.Errorf(codes.InvalidArgument, "unsupported model family: %s", req.ModelFamily)
	}

	maxTokens := tokenLimit
	if req.MaxTokens != 0 {
		maxTokens = req.MaxTokens
	}

	prompt := req.Prompt

	selectedModels := llmModelPriority
	if req.Model != pb.Model_MODEL_UNSPECIFIED {
		selectedModels = []pb.Model{req.Model}
	}

	summary, model, err := s.summaryInternal(ctx, req.ModelFamily, prompt, req.Text, selectedModels, maxTokens)
	if err != nil {
		return nil, fmt.Errorf("failed to generate summary: %v", err)
	}

	return &pb.LLMSummaryResponse{Summary: summary, Model: model}, nil
}

func (s *llmServer) summaryInternal(ctx context.Context, modelFamily pb.ModelFamily,
	prompt, text string, models []pb.Model, maxTokens int32) (string, pb.Model, error) {
	for _, model := range models {
		if _, ok := llmModelNames[model]; !ok {
			return "", pb.Model_MODEL_UNSPECIFIED, status.Errorf(codes.InvalidArgument, "unsupported model: %s", model)
		}

		summary, err := s.tryGenerateSummary(ctx, modelFamily, prompt, text, model, maxTokens)
		if err != nil {
			log.Warningf("Error generating summary with model %s: %v", model, err)
			time.Sleep(time.Second)
			continue
		}
		if summary != "" {
			log.Infof("Successfully generated summary with model %s", model)
			return summary, model, nil
		}
	}
	log.Errorf("Failed to generate summary with all models")
	return "", pb.Model_MODEL_UNSPECIFIED, status.Errorf(codes.Internal,
		"failed to generate summary with all models: %v", models)
}

func (s *llmServer) tryGenerateSummary(ctx context.Context, modelFamily pb.ModelFamily,
	prompt, text string, model pb.Model, maxTokens int32) (string, error) {
	switch modelFamily {
	case pb.ModelFamily_MODEL_FAMILY_GEMINI:
		return s.summaryByGemini(ctx, prompt, text, model, maxTokens)
	default:
		return "", status.Errorf(codes.InvalidArgument, "unsupported model family: %s", modelFamily)
	}
}

func (s *llmServer) summaryByGemini(ctx context.Context, prompt, content string,
	llmModel pb.Model, maxTokens int32) (string, error) {
	if *geminiAPIKey == "" {
		return "", status.Error(codes.InvalidArgument, "gemini-api-key is empty")
	}

	client, err := genai.NewClient(ctx, &genai.ClientConfig{
		APIKey:  *geminiAPIKey,
		Backend: genai.BackendGeminiAPI,
	})
	if err != nil {
		return "", fmt.Errorf("failed to create Gemini client: %v", err)
	}

	llmModelName, ok := llmModelNames[llmModel]
	if !ok {
		return "", status.Errorf(codes.InvalidArgument, "unsupported model: %s", llmModel)
	}

	contentWithPrompt := fmt.Sprintf("%s\n%s", prompt, content)

	// Create content for the new API
	parts := []*genai.Part{{Text: contentWithPrompt}}
	contents := []*genai.Content{{Parts: parts}}

	// Count tokens first
	respToken, err := client.Models.CountTokens(ctx, llmModelName, contents, nil)
	if err != nil {
		return "", fmt.Errorf("failed to count tokens: %v", err)
	}

	for respToken.TotalTokens > maxTokens {
		contentWithPrompt = contentWithPrompt[:len(contentWithPrompt)/10*9]
		parts = []*genai.Part{{Text: contentWithPrompt}}
		contents = []*genai.Content{{Parts: parts}}
		respToken, err = client.Models.CountTokens(ctx, llmModelName, contents, nil)
		if err != nil {
			return "", fmt.Errorf("failed to count tokens: %v", err)
		}
	}

	resp, err := client.Models.GenerateContent(ctx, llmModelName, contents, nil)
	if err != nil {
		return "", fmt.Errorf("failed to generate content: %v", err)
	}

	if len(resp.Candidates) == 0 || resp.Candidates[0].Content == nil {
		return "", fmt.Errorf("no content generated")
	}

	if len(resp.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("no content parts generated")
	}

	return resp.Candidates[0].Content.Parts[0].Text, nil
}

func main() {
	initLogger()
	flag.Parse()

	err := utils.StartGRPCServer[pb.LLMSummaryServiceServer](
		*port,
		&llmServer{},
		pb.RegisterLLMSummaryServiceServer,
	)
	if err != nil {
		log.Fatalf("server error: %v", err)
	}
}
