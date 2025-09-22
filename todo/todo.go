package main

import (
	"context"
	"flag"
	"fmt"
	"slices"
	"time"

	"github.com/badoux/checkmail"
	"github.com/mailjet/mailjet-apiv3-go/v4"
	"github.com/sirupsen/logrus"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/jomei/notionapi"
	pb "github.com/ziyixi/protos/go/todofy"
	"github.com/ziyixi/todofy/todo/internal/todoist"
)

var log = logrus.New()
var GitCommit string // Will be set by Bazel at build time

func init() {
	log.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})
}

var (
	port = flag.Int("port", 50052, "The server port of the Todo service")

	// Mailjet API credentials
	mailjetAPIKeyPublic  = flag.String("mailjet-api-key-public", "", "The public API key for Mailjet")
	mailjetAPIKeyPrivate = flag.String("mailjet-api-key-private", "", "The private API key for Mailjet")
	targetEmail          = flag.String("target-email", "", "The target email address to send the todo to")

	// Notion API credentials
	notionAPIKey     = flag.String("notion-api-key", "", "The API key for Notion")
	notionDataBaseID = flag.String("notion-database-id", "", "The database ID for Notion")

	// Todoist API credentials
	todoistAPIKey    = flag.String("todoist-api-key", "", "The API key for Todoist")
	todoistProjectID = flag.String("todoist-project-id", "", "The project ID for Todoist tasks")
)

type todoServer struct {
	pb.TodoServiceServer
}

func (s *todoServer) PopulateTodo(ctx context.Context, req *pb.TodoRequest) (*pb.TodoResponse, error) {
	supportedMethod, ok := allowedPopullateTodoMethod[req.App]
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument, "unsupported app: %s", req.App)
	}
	if !slices.Contains(supportedMethod, req.Method) {
		return nil, status.Errorf(codes.InvalidArgument, "unsupported method %s for app %s", req.Method, req.App)
	}

	switch req.Method {
	case pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_MAILJET:
		return s.PopulateTodoByMailjet(ctx, req)
	case pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_NOTION:
		return s.PopulateTodoByNotion(ctx, req)
	case pb.PopullateTodoMethod_POPULLATE_TODO_METHOD_TODOIST:
		return s.PopulateTodoByTodoist(ctx, req)
	default:
		return nil, status.Errorf(codes.InvalidArgument, "unsupported method: %s", req.Method)
	}
}

func validateMailjetFlags() error {
	if len(*mailjetAPIKeyPublic) == 0 {
		return status.Errorf(codes.InvalidArgument, "missing mailjet API public key")
	}
	if len(*mailjetAPIKeyPrivate) == 0 {
		return status.Errorf(codes.InvalidArgument, "missing mailjet API private key")
	}
	if err := checkmail.ValidateFormat(*targetEmail); err != nil {
		return status.Errorf(codes.InvalidArgument, "invalid target email address: %s", *targetEmail)
	}
	return nil
}

func (s *todoServer) PopulateTodoByMailjet(ctx context.Context, req *pb.TodoRequest) (*pb.TodoResponse, error) {
	if err := validateMailjetFlags(); err != nil {
		return nil, err
	}
	mailjetClient := mailjet.NewMailjetClient(*mailjetAPIKeyPublic, *mailjetAPIKeyPrivate)

	toEmail := *targetEmail
	toEmailName := receiverName
	if req.To != "" {
		toEmail = req.To
		toEmailName = req.ToName
	}
	messagesInfo := []mailjet.InfoMessagesV31{
		{
			From: &mailjet.RecipientV31{
				Email: sender,
				Name:  senderName,
			},
			To: &mailjet.RecipientsV31{
				mailjet.RecipientV31{
					Email: toEmail,
					Name:  toEmailName,
				},
			},
			Subject:  fmt.Sprintf("%v [%v]", req.Subject, req.From),
			TextPart: req.Body,
		},
	}
	messages := mailjet.MessagesV31{Info: messagesInfo}
	res, err := mailjetClient.SendMailV31(&messages)
	if err != nil {
		return nil, fmt.Errorf("mailjet send email error: %w", err)
	}
	if len(res.ResultsV31) == 0 || len(res.ResultsV31[0].To) == 0 {
		return nil, fmt.Errorf("mailjet send email API response error: %v", res)
	}
	mailjetHref := res.ResultsV31[0].To[0].MessageHref

	// send request to mailjet API to get email send status
	response, err := utils.FetchWithBasicAuth(mailjetHref, *mailjetAPIKeyPublic, *mailjetAPIKeyPrivate)
	if err != nil {
		return nil, fmt.Errorf("fetch mailjet email status error: %w", err)
	}
	log.Infof("Mailjet email status: %v", response)
	return &pb.TodoResponse{
		Message: fmt.Sprintf("%v", response),
	}, nil
}

func validateNotionFlags() error {
	if len(*notionAPIKey) == 0 {
		return status.Errorf(codes.InvalidArgument, "missing notion API key")
	}
	if len(*notionDataBaseID) == 0 {
		return status.Errorf(codes.InvalidArgument, "missing notion database ID")
	}
	return nil
}

func (s *todoServer) PopulateTodoByNotion(ctx context.Context, req *pb.TodoRequest) (*pb.TodoResponse, error) {
	if err := validateNotionFlags(); err != nil {
		return nil, err
	}
	client := notionapi.NewClient(notionapi.Token(*notionAPIKey))

	// Create a new page in the database
	pageRequest := &notionapi.PageCreateRequest{
		Parent: notionapi.Parent{
			Type:       "database_id",
			DatabaseID: notionapi.DatabaseID(*notionDataBaseID),
		},
		Properties: notionapi.Properties{
			"Name": notionapi.TitleProperty{
				Title: []notionapi.RichText{
					{
						PlainText: req.Subject,
						Text: &notionapi.Text{
							Content: req.Subject,
						},
					},
				},
			},
			"Added time": notionapi.DateProperty{
				Date: &notionapi.DateObject{
					Start: func() *notionapi.Date {
						d := notionapi.Date(time.Now())
						return &d
					}(),
				},
			},
			"From": notionapi.RichTextProperty{
				RichText: []notionapi.RichText{
					{
						PlainText: req.From,
						Text: &notionapi.Text{
							Content: req.From,
						},
					},
				},
			},
			"Summary": notionapi.RichTextProperty{
				RichText: []notionapi.RichText{
					{
						PlainText: req.Body,
						Text: &notionapi.Text{
							Content: req.Body,
						},
					},
				},
			},
		},
	}

	// Add body content as blocks if body is provided
	if req.Body != "" {
		pageRequest.Children = []notionapi.Block{
			&notionapi.ParagraphBlock{
				BasicBlock: notionapi.BasicBlock{
					Object: notionapi.ObjectTypeBlock,
					Type:   notionapi.BlockTypeParagraph,
				},
				Paragraph: notionapi.Paragraph{
					RichText: []notionapi.RichText{
						{
							PlainText: req.Body,
							Text: &notionapi.Text{
								Content: req.Body,
							},
						},
					},
				},
			},
		}
	}

	page, err := client.Page.Create(ctx, pageRequest)
	if err != nil {
		return nil, fmt.Errorf("failed to create page in database: %w", err)
	}

	message := fmt.Sprintf("Successfully created page with ID: %s", page.ID)

	return &pb.TodoResponse{
		Id:      string(page.ID),
		Message: message,
	}, nil
}

func validateTodoistFlags() error {
	if len(*todoistAPIKey) == 0 {
		return status.Errorf(codes.InvalidArgument, "missing todoist API key")
	}
	return nil
}

func (s *todoServer) PopulateTodoByTodoist(ctx context.Context, req *pb.TodoRequest) (*pb.TodoResponse, error) {
	if err := validateTodoistFlags(); err != nil {
		return nil, err
	}

	client := todoist.NewClient(*todoistAPIKey)

	// Create the task request
	taskRequest := &todoist.CreateTaskRequest{
		Content:     req.Subject,
		Description: req.Body,
	}

	// Add project ID if specified
	if *todoistProjectID != "" {
		taskRequest.ProjectID = *todoistProjectID
	}

	// Generate a request ID for idempotency (optional)
	requestID := fmt.Sprintf("todofy-%d", time.Now().Unix())

	// Create the task
	task, err := client.CreateTask(ctx, requestID, taskRequest)
	if err != nil {
		return nil, fmt.Errorf("failed to create task in Todoist: %w", err)
	}

	message := fmt.Sprintf("Successfully created task: %s (ID: %s)", task.Content, task.ID)

	return &pb.TodoResponse{
		Id:      task.ID,
		Message: message,
	}, nil
}

func main() {
	flag.Parse()

	err := utils.StartGRPCServer[pb.TodoServiceServer](
		*port,
		&todoServer{},
		pb.RegisterTodoServiceServer,
	)
	if err != nil {
		log.Fatalf("server error: %v", err)
	}
}
