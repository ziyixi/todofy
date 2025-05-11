package main

import (
	"context"
	"flag"
	"fmt"
	"slices"

	"github.com/badoux/checkmail"
	"github.com/mailjet/mailjet-apiv3-go/v4"
	"github.com/sirupsen/logrus"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/ziyixi/protos/go/todofy"
)

var log = logrus.New()

func init() {
	log.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})
}

var (
	port                 = flag.Int("port", 50052, "The server port of the Todo service")
	mailjetAPIKeyPublic  = flag.String("mailjet-api-key-public", "", "The public API key for Mailjet")
	mailjetAPIKeyPrivate = flag.String("mailjet-api-key-private", "", "The private API key for Mailjet")
	targetEmail          = flag.String("target-email", "", "The target email address to send the todo to")
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
