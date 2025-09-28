package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	pb "github.com/ziyixi/protos/go/todofy"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestDatabaseServer_CreateIfNotExist(t *testing.T) {
	t.Run("successful SQLite database creation", func(t *testing.T) {
		server := &databaseServer{}

		// Use in-memory SQLite for testing
		req := &pb.CreateIfNotExistRequest{
			Type: pb.DatabaseType_DATABASE_TYPE_SQLITE,
			Path: ":memory:",
		}

		resp, err := server.CreateIfNotExist(context.Background(), req)

		assert.NoError(t, err)
		assert.NotNil(t, resp)
		assert.NotNil(t, server.db)
	})

	t.Run("successful file-based SQLite database creation", func(t *testing.T) {
		server := &databaseServer{}

		// Create temporary file for database
		tmpFile, err := os.CreateTemp("", "test_db_*.db")
		require.NoError(t, err)
		defer func() {
			_ = os.Remove(tmpFile.Name()) // Best effort cleanup
		}()
		_ = tmpFile.Close() // Best effort close

		req := &pb.CreateIfNotExistRequest{
			Type: pb.DatabaseType_DATABASE_TYPE_SQLITE,
			Path: tmpFile.Name(),
		}

		resp, err := server.CreateIfNotExist(context.Background(), req)

		assert.NoError(t, err)
		assert.NotNil(t, resp)
		assert.NotNil(t, server.db)

		// Verify the database file exists
		_, err = os.Stat(tmpFile.Name())
		assert.NoError(t, err)
	})

	t.Run("unsupported database type", func(t *testing.T) {
		server := &databaseServer{}

		req := &pb.CreateIfNotExistRequest{
			Type: pb.DatabaseType_DATABASE_TYPE_UNSPECIFIED,
			Path: ":memory:",
		}

		resp, err := server.CreateIfNotExist(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "unsupported database type")
		assert.Nil(t, server.db)
	})

	t.Run("invalid database path", func(t *testing.T) {
		server := &databaseServer{}

		req := &pb.CreateIfNotExistRequest{
			Type: pb.DatabaseType_DATABASE_TYPE_SQLITE,
			Path: "/invalid/path/that/does/not/exist/test.db",
		}

		resp, err := server.CreateIfNotExist(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "failed to open SQLite database")
	})
}

func TestDatabaseServer_Write(t *testing.T) {
	t.Run("successful write to database", func(t *testing.T) {
		// Setup database
		server := setupTestDatabase(t)

		req := &pb.WriteRequest{
			Schema: &pb.DataBaseSchema{
				ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
				Model:       pb.Model_MODEL_GEMINI_2_5_PRO,
				Prompt:      "Test prompt",
				MaxTokens:   1024,
				Text:        "Test text content",
				Summary:     "Test summary",
			},
		}

		resp, err := server.Write(context.Background(), req)

		assert.NoError(t, err)
		assert.NotNil(t, resp)

		// Verify the data was written
		var entry DatabaseEntry
		err = server.db.First(&entry).Error
		assert.NoError(t, err)
		assert.Equal(t, int32(pb.ModelFamily_MODEL_FAMILY_GEMINI), entry.ModelFamily)
		assert.Equal(t, int32(pb.Model_MODEL_GEMINI_2_5_PRO), entry.LLMModel)
		assert.Equal(t, "Test prompt", entry.Prompt)
		assert.Equal(t, int32(1024), entry.MaxTokens)
		assert.Equal(t, "Test text content", entry.Text)
		assert.Equal(t, "Test summary", entry.Summary)
	})

	t.Run("write without database initialization", func(t *testing.T) {
		server := &databaseServer{} // No database initialization

		req := &pb.WriteRequest{
			Schema: &pb.DataBaseSchema{
				ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
				Model:       pb.Model_MODEL_GEMINI_2_5_PRO,
				Prompt:      "Test prompt",
				Text:        "Test text content",
				Summary:     "Test summary",
			},
		}

		resp, err := server.Write(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "database not initialized")
	})

	t.Run("write with empty schema", func(t *testing.T) {
		server := setupTestDatabase(t)

		req := &pb.WriteRequest{
			Schema: &pb.DataBaseSchema{
				// Empty schema
			},
		}

		resp, err := server.Write(context.Background(), req)

		// Should succeed as GORM will use default values
		assert.NoError(t, err)
		assert.NotNil(t, resp)
	})
}

func TestDatabaseServer_QueryRecent(t *testing.T) {
	t.Run("query recent entries", func(t *testing.T) {
		server := setupTestDatabase(t)

		// Insert test data with different timestamps
		entries := []DatabaseEntry{
			{
				ModelFamily: int32(pb.ModelFamily_MODEL_FAMILY_GEMINI),
				LLMModel:    int32(pb.Model_MODEL_GEMINI_2_5_PRO),
				Prompt:      "Prompt 1",
				Text:        "Text 1",
				Summary:     "Summary 1",
				Model: gorm.Model{
					CreatedAt: time.Now().Add(-30 * time.Second),
					UpdatedAt: time.Now().Add(-30 * time.Second),
				},
			},
			{
				ModelFamily: int32(pb.ModelFamily_MODEL_FAMILY_GEMINI),
				LLMModel:    int32(pb.Model_MODEL_GEMINI_2_5_FLASH),
				Prompt:      "Prompt 2",
				Text:        "Text 2",
				Summary:     "Summary 2",
				Model: gorm.Model{
					CreatedAt: time.Now().Add(-120 * time.Second), // Outside range
					UpdatedAt: time.Now().Add(-120 * time.Second),
				},
			},
		}

		for _, entry := range entries {
			err := server.db.Create(&entry).Error
			require.NoError(t, err)
		}

		req := &pb.QueryRecentRequest{
			TimeAgoInSeconds: 60, // Query last 60 seconds
		}

		resp, err := server.QueryRecent(context.Background(), req)

		assert.NoError(t, err)
		assert.NotNil(t, resp)
		assert.Len(t, resp.Entries, 1) // Only one entry within 60 seconds
		assert.Equal(t, "Prompt 1", resp.Entries[0].Prompt)
		assert.Equal(t, "Summary 1", resp.Entries[0].Summary)
	})

	t.Run("query with zero time range", func(t *testing.T) {
		server := setupTestDatabase(t)

		req := &pb.QueryRecentRequest{
			TimeAgoInSeconds: 0,
		}

		resp, err := server.QueryRecent(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "time ago in seconds must be greater than 0")
	})

	t.Run("query with negative time range", func(t *testing.T) {
		server := setupTestDatabase(t)

		req := &pb.QueryRecentRequest{
			TimeAgoInSeconds: -30,
		}

		resp, err := server.QueryRecent(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "time ago in seconds must be greater than 0")
	})

	t.Run("query without database initialization", func(t *testing.T) {
		server := &databaseServer{} // No database initialization

		req := &pb.QueryRecentRequest{
			TimeAgoInSeconds: 60,
		}

		resp, err := server.QueryRecent(context.Background(), req)

		assert.Error(t, err)
		assert.Nil(t, resp)
		assert.Contains(t, err.Error(), "database not initialized")
	})

	t.Run("query empty database", func(t *testing.T) {
		server := setupTestDatabase(t)

		req := &pb.QueryRecentRequest{
			TimeAgoInSeconds: 60,
		}

		resp, err := server.QueryRecent(context.Background(), req)

		assert.NoError(t, err)
		assert.NotNil(t, resp)
		assert.Len(t, resp.Entries, 0)
	})
}

func TestDatabaseEntry_Model(t *testing.T) {
	t.Run("database entry structure", func(t *testing.T) {
		entry := DatabaseEntry{
			ModelFamily: int32(pb.ModelFamily_MODEL_FAMILY_GEMINI),
			LLMModel:    int32(pb.Model_MODEL_GEMINI_2_5_PRO),
			Prompt:      "Test prompt",
			MaxTokens:   1024,
			Text:        "Test text",
			Summary:     "Test summary",
		}

		assert.Equal(t, int32(pb.ModelFamily_MODEL_FAMILY_GEMINI), entry.ModelFamily)
		assert.Equal(t, int32(pb.Model_MODEL_GEMINI_2_5_PRO), entry.LLMModel)
		assert.Equal(t, "Test prompt", entry.Prompt)
		assert.Equal(t, int32(1024), entry.MaxTokens)
		assert.Equal(t, "Test text", entry.Text)
		assert.Equal(t, "Test summary", entry.Summary)
	})

	t.Run("gorm model fields", func(t *testing.T) {
		entry := DatabaseEntry{}

		// Check that GORM Model fields are embedded
		assert.Equal(t, uint(0), entry.ID)            // Default value
		assert.True(t, entry.CreatedAt.IsZero())      // Default value
		assert.True(t, entry.UpdatedAt.IsZero())      // Default value
		assert.True(t, entry.DeletedAt.Time.IsZero()) // Default value for soft delete
	})
}

func TestDatabaseIntegration(t *testing.T) {
	t.Run("full workflow: create, write, query", func(t *testing.T) {
		server := &databaseServer{}

		// Step 1: Initialize database
		createReq := &pb.CreateIfNotExistRequest{
			Type: pb.DatabaseType_DATABASE_TYPE_SQLITE,
			Path: ":memory:",
		}

		_, err := server.CreateIfNotExist(context.Background(), createReq)
		require.NoError(t, err)

		// Step 2: Write data
		writeReq := &pb.WriteRequest{
			Schema: &pb.DataBaseSchema{
				ModelFamily: pb.ModelFamily_MODEL_FAMILY_GEMINI,
				Model:       pb.Model_MODEL_GEMINI_2_5_PRO,
				Prompt:      "Integration test prompt",
				MaxTokens:   2048,
				Text:        "Integration test text",
				Summary:     "Integration test summary",
			},
		}

		_, err = server.Write(context.Background(), writeReq)
		require.NoError(t, err)

		// Step 3: Query recent data
		queryReq := &pb.QueryRecentRequest{
			TimeAgoInSeconds: 60,
		}

		resp, err := server.QueryRecent(context.Background(), queryReq)
		require.NoError(t, err)

		// Verify results
		assert.Len(t, resp.Entries, 1)
		entry := resp.Entries[0]
		assert.Equal(t, pb.ModelFamily_MODEL_FAMILY_GEMINI, entry.ModelFamily)
		assert.Equal(t, pb.Model_MODEL_GEMINI_2_5_PRO, entry.Model)
		assert.Equal(t, "Integration test prompt", entry.Prompt)
		assert.Equal(t, int32(2048), entry.MaxTokens)
		assert.Equal(t, "Integration test text", entry.Text)
		assert.Equal(t, "Integration test summary", entry.Summary)
		assert.NotNil(t, entry.CreatedAt)
		assert.NotNil(t, entry.UpdatedAt)
	})
}

// setupTestDatabase creates a test database server with in-memory SQLite
func setupTestDatabase(t *testing.T) *databaseServer {
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	require.NoError(t, err)

	err = db.AutoMigrate(&DatabaseEntry{})
	require.NoError(t, err)

	return &databaseServer{
		db: db,
	}
}
