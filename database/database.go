package main

import (
	"context"
	"flag"
	"time"

	"github.com/sirupsen/logrus"
	"github.com/ziyixi/todofy/utils"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"

	pb "github.com/ziyixi/protos/go/todofy"
	timestamppb "google.golang.org/protobuf/types/known/timestamppb"
)

var log = logrus.New()

func init() {
	log.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})
}

var (
	port = flag.Int("port", 50053, "The server port of the database service")
)

type databaseServer struct {
	pb.DataBaseServiceServer
	db *gorm.DB
}

type DatabaseEntry struct {
	gorm.Model
	ModelFamily int32
	LLMModel    int32
	Prompt      string
	MaxTokens   int32
	Text        string
	Summary     string
}

func (s *databaseServer) CreateIfNotExist(ctx context.Context, req *pb.CreateIfNotExistRequest) (*pb.CreateIfNotExistResponse, error) {
	switch req.Type {
	case pb.DatabaseType_DATABASE_TYPE_SQLITE:
		db, err := gorm.Open(sqlite.Open(req.Path), &gorm.Config{})
		if err != nil {
			return nil, status.Errorf(codes.Internal, "failed to open SQLite database: %v", err)
		}
		if err := db.AutoMigrate(&DatabaseEntry{}); err != nil {
			return nil, status.Errorf(codes.Internal, "failed to migrate SQLite database: %v", err)
		}
		s.db = db
	default:
		return nil, status.Errorf(codes.InvalidArgument, "unsupported database type: %v", req.Type)
	}
	log.Infof("Database initialized at %s", req.Path)
	return &pb.CreateIfNotExistResponse{}, nil
}

// Write implements the Write RPC method
func (s *databaseServer) Write(ctx context.Context, req *pb.WriteRequest) (*pb.WriteResponse, error) {
	entry := DatabaseEntry{
		ModelFamily: int32(req.Schema.ModelFamily),
		LLMModel:    int32(req.Schema.Model),
		Prompt:      req.Schema.Prompt,
		MaxTokens:   req.Schema.MaxTokens,
		Text:        req.Schema.Text,
		Summary:     req.Schema.Summary,
	}
	if s.db == nil {
		return nil, status.Errorf(codes.FailedPrecondition, "database not initialized")
	}
	if err := s.db.Create(&entry).Error; err != nil {
		return nil, status.Errorf(codes.Internal, "failed to create entry: %v", err)
	}
	log.Infof("Entry created for model %s with max tokens %d", req.Schema.Model, req.Schema.MaxTokens)
	return &pb.WriteResponse{}, nil
}

// QueryRecent implements the QueryRecent RPC method
func (s *databaseServer) QueryRecent(ctx context.Context, req *pb.QueryRecentRequest) (*pb.QueryRecentResponse, error) {
	if s.db == nil {
		return nil, status.Errorf(codes.FailedPrecondition, "database not initialized")
	}

	var entries []DatabaseEntry

	if req.TimeAgoInSeconds <= 0 {
		return nil, status.Errorf(codes.InvalidArgument, "time ago in seconds must be greater than 0")
	}
	now := time.Now()
	from := now.Add(-time.Second * time.Duration(req.TimeAgoInSeconds))

	// Query the database for entries created within the specified time range
	if err := s.db.Where("created_at BETWEEN ? AND ?", from, now).Find(&entries).Error; err != nil {
		return nil, status.Errorf(codes.Internal, "failed to query database: %v", err)
	}
	// Convert entries to protobuf format
	schemas := make([]*pb.DataBaseSchema, len(entries))
	for i, entry := range entries {
		schemas[i] = &pb.DataBaseSchema{
			ModelFamily: pb.ModelFamily(entry.ModelFamily),
			Model:       pb.Model(entry.LLMModel),
			Prompt:      entry.Prompt,
			MaxTokens:   entry.MaxTokens,
			Text:        entry.Text,
			Summary:     entry.Summary,
			CreatedAt:   timestamppb.New(entry.CreatedAt),
			UpdatedAt:   timestamppb.New(entry.UpdatedAt),
		}
	}
	log.Infof("Queried %d entries from the database between %s and %s", len(entries), from.Format(time.RFC3339), now.Format(time.RFC3339))
	return &pb.QueryRecentResponse{
		Entries: schemas,
	}, nil
}

func main() {
	flag.Parse()

	err := utils.StartGRPCServer[pb.DataBaseServiceServer](
		*port,
		&databaseServer{},
		pb.RegisterDataBaseServiceServer,
	)
	if err != nil {
		log.Fatalf("server error: %v", err)
	}
}
