package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/ziyixi/mail-hero/internal/config"
	"github.com/ziyixi/mail-hero/internal/delivery"
	"github.com/ziyixi/mail-hero/internal/httpapi"
	smtpserver "github.com/ziyixi/mail-hero/internal/smtp"
	"github.com/ziyixi/mail-hero/internal/store"
	"github.com/ziyixi/mail-hero/internal/worker"
	"github.com/ziyixi/mail-hero/migrations"
	"github.com/ziyixi/mail-hero/uiassets"
)

const singletonLock int64 = 557840730510

func main() {
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	if command != "serve" && command != "migrate" {
		fmt.Fprintln(os.Stderr, "usage: mail-hero [serve|migrate]")
		os.Exit(2)
	}
	cfg, err := config.LoadFromEnv()
	if err != nil {
		fatal("invalid configuration", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err = run(ctx, cfg, command); err != nil && !errors.Is(err, context.Canceled) {
		fatal("mail-hero stopped", err)
	}
}
func fatal(message string, err error) { slog.Error(message, "error", safeError(err)); os.Exit(1) }
func safeError(err error) string {
	if err == nil {
		return ""
	}
	text := err.Error()
	if len(text) > 160 {
		text = text[:160]
	}
	// Configuration and SQL errors might contain credential strings. The detailed
	// error stays out of stdout, structured logs and HTTP responses.
	if strings.Contains(strings.ToLower(text), "password") || strings.Contains(text, "postgres://") || strings.Contains(text, "postgresql://") {
		return "redacted"
	}
	return text
}
func run(ctx context.Context, cfg config.Config, command string) error {
	db, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	lockConn, err := db.Pool().Acquire(ctx)
	if err != nil {
		return err
	}
	defer lockConn.Release()
	var acquired bool
	if err = lockConn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, singletonLock).Scan(&acquired); err != nil {
		return err
	}
	if !acquired {
		return errors.New("another mail-hero instance owns the database")
	}
	defer lockConn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, singletonLock)
	if err = migrate(ctx, cfg.DatabaseURL); err != nil {
		return err
	}
	if command == "migrate" {
		slog.Info("schema migration complete")
		return nil
	}
	if _, err = db.ReconcileLogicalBytes(ctx); err != nil {
		return err
	}
	key, err := loadKey(cfg.SecretKeyFile)
	if err != nil {
		return err
	}
	manager := &delivery.Manager{Pool: db.Pool(), Key: key, ReceiveAddress: cfg.ReceiveAddress, ForcePaused: cfg.ForceSendPaused, AllowedInternalTargets: cfg.AllowedInternalTargets}
	work := &worker.Worker{Pool: db.Pool(), Delivery: manager, Store: db}
	if err = work.Recover(ctx); err != nil {
		return err
	}
	api, err := httpapi.New(cfg, db.Pool(), manager, key)
	if err != nil {
		return err
	}
	assets, err := uiassets.Handler()
	if err != nil {
		return err
	}
	root := http.NewServeMux()
	root.Handle("/api/", api.Handler())
	root.Handle("/health/", api.Handler())
	root.Handle("/", assets)
	httpServer := &http.Server{Addr: cfg.HTTPListenAddress, Handler: root, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	var smtp *smtpserver.Server
	if cfg.IngestTransport == "smtp" {
		smtp, err = smtpserver.NewServer(cfg, db)
		if err != nil {
			return err
		}
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan error, 3)
	go func() { results <- httpServer.ListenAndServe() }()
	if smtp != nil {
		go func() { results <- smtp.ListenAndServe() }()
	}
	go func() { results <- work.Run(runCtx) }()
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				if err := lockConn.Ping(runCtx); err != nil {
					results <- errors.New("database singleton lock connection lost")
					return
				}
			}
		}
	}()
	slog.Info("mail-hero listening", "http", cfg.HTTPListenAddress, "ingest_transport", cfg.IngestTransport)
	select {
	case <-ctx.Done():
	case err = <-results:
		if err == nil || errors.Is(err, http.ErrServerClosed) || errors.Is(err, context.Canceled) {
			err = errors.New("mail-hero listener unexpectedly stopped")
		}
	}
	cancel()
	shutdownCtx, done := context.WithTimeout(context.Background(), 15*time.Second)
	defer done()
	_ = httpServer.Shutdown(shutdownCtx)
	if smtp != nil {
		_ = smtp.Shutdown(shutdownCtx)
	}
	if ctx.Err() != nil {
		return nil
	}
	return err
}
func migrate(ctx context.Context, databaseURL string) error {
	sqlDB, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return err
	}
	defer sqlDB.Close()
	if err = goose.SetDialect("postgres"); err != nil {
		return err
	}
	goose.SetBaseFS(migrations.FS)
	return goose.UpContext(ctx, sqlDB, ".")
}
func loadKey(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read secret key file: %w", err)
	}
	if len(raw) == 32 {
		return raw, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("secret key file must contain 32 raw bytes or base64-encoded 32 bytes")
	}
	return decoded, nil
}
