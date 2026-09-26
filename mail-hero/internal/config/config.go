package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const DefaultMaxMessageBytes int64 = 25 << 20

var (
	localPartPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9._+-]*$`)
	domainLabelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
)

// Config contains deployment settings only. Target URLs, credentials, delivery mode,
// rate limits, and retention are changed in the UI and live in PostgreSQL.
type Config struct {
	ReceiveAddress         string
	IngestTransport        string
	IngestTokenFile        string
	DatabaseURL            string
	DatabaseURLFile        string
	SMTPListenAddress      string
	HTTPListenAddress      string
	MXHostname             string
	SMTPTLSCertFile        string
	SMTPTLSKeyFile         string
	AccessIssuer           string
	AccessAudience         string
	AccessOwner            string
	SecretKeyFile          string
	ForceSendPaused        bool
	AllowedInternalTargets []string
	DevAuthBypass          bool
	AllowInsecureSMTP      bool
	MaxMessageBytes        int64
}

func LoadFromEnv() (Config, error) {
	forcePaused, err := envBool("MAIL_HERO_FORCE_SEND_PAUSED")
	if err != nil {
		return Config{}, err
	}
	devBypass, err := envBool("MAIL_HERO_DEV_AUTH_BYPASS")
	if err != nil {
		return Config{}, err
	}
	insecureSMTP, err := envBool("MAIL_HERO_ALLOW_INSECURE_SMTP")
	if err != nil {
		return Config{}, err
	}
	address, err := CanonicalReceiveAddress(os.Getenv("MAIL_HERO_RECEIVE_ADDRESS"))
	if err != nil {
		return Config{}, fmt.Errorf("MAIL_HERO_RECEIVE_ADDRESS: %w", err)
	}
	httpListen := envDefault("MAIL_HERO_HTTP_LISTEN", "127.0.0.1:8080")
	smtpListen := envDefault("MAIL_HERO_SMTP_LISTEN", ":2525")
	databaseURLFile := strings.TrimSpace(os.Getenv("MAIL_HERO_DATABASE_URL_FILE"))
	var databaseURL string
	if databaseURLFile != "" {
		contents, err := os.ReadFile(databaseURLFile)
		if err != nil {
			return Config{}, fmt.Errorf("read MAIL_HERO_DATABASE_URL_FILE: %w", err)
		}
		databaseURL = strings.TrimSpace(string(contents))
	} else if devBypass && insecureSMTP && loopbackListener(httpListen) && loopbackListener(smtpListen) {
		// Local development convenience only. Production credentials belong in a
		// permission-restricted file, outside the process environment.
		databaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	} else {
		return Config{}, errors.New("MAIL_HERO_DATABASE_URL_FILE is required outside loopback development mode")
	}
	c := Config{
		ReceiveAddress:         address,
		IngestTransport:        envDefault("MAIL_HERO_INGEST_TRANSPORT", "smtp"),
		IngestTokenFile:        strings.TrimSpace(os.Getenv("MAIL_HERO_INGEST_TOKEN_FILE")),
		DatabaseURL:            databaseURL,
		DatabaseURLFile:        databaseURLFile,
		SMTPListenAddress:      smtpListen,
		HTTPListenAddress:      httpListen,
		MXHostname:             strings.ToLower(strings.TrimSpace(os.Getenv("MAIL_HERO_MX_HOSTNAME"))),
		SMTPTLSCertFile:        strings.TrimSpace(os.Getenv("MAIL_HERO_SMTP_TLS_CERT_FILE")),
		SMTPTLSKeyFile:         strings.TrimSpace(os.Getenv("MAIL_HERO_SMTP_TLS_KEY_FILE")),
		AccessIssuer:           strings.TrimSpace(os.Getenv("MAIL_HERO_ACCESS_ISSUER")),
		AccessAudience:         strings.TrimSpace(os.Getenv("MAIL_HERO_ACCESS_AUDIENCE")),
		AccessOwner:            strings.TrimSpace(os.Getenv("MAIL_HERO_ACCESS_OWNER")),
		SecretKeyFile:          strings.TrimSpace(os.Getenv("MAIL_HERO_SECRET_KEY_FILE")),
		ForceSendPaused:        forcePaused,
		AllowedInternalTargets: splitNonempty(os.Getenv("MAIL_HERO_ALLOWED_INTERNAL_TARGETS")),
		DevAuthBypass:          devBypass,
		AllowInsecureSMTP:      insecureSMTP,
		MaxMessageBytes:        DefaultMaxMessageBytes,
	}
	return c, c.Validate()
}

func (c Config) Validate() error {
	if _, err := CanonicalReceiveAddress(c.ReceiveAddress); err != nil {
		return fmt.Errorf("receive address: %w", err)
	}
	if c.DatabaseURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	if _, _, err := net.SplitHostPort(c.SMTPListenAddress); err != nil {
		return fmt.Errorf("MAIL_HERO_SMTP_LISTEN: %w", err)
	}
	if _, _, err := net.SplitHostPort(c.HTTPListenAddress); err != nil {
		return fmt.Errorf("MAIL_HERO_HTTP_LISTEN: %w", err)
	}
	if c.DevAuthBypass {
		if !loopbackListener(c.HTTPListenAddress) {
			return errors.New("development auth bypass requires a loopback HTTP listener")
		}
	} else if c.AccessIssuer == "" || c.AccessAudience == "" || c.AccessOwner == "" {
		return errors.New("Cloudflare Access issuer, audience and owner are required")
	}
	if c.SecretKeyFile == "" {
		return errors.New("MAIL_HERO_SECRET_KEY_FILE is required")
	}
	if c.IngestTransport != "smtp" && c.IngestTransport != "cloudflare" {
		return errors.New("MAIL_HERO_INGEST_TRANSPORT must be smtp or cloudflare")
	}
	if c.IngestTransport == "cloudflare" {
		if c.IngestTokenFile == "" {
			return errors.New("MAIL_HERO_INGEST_TOKEN_FILE is required for Cloudflare ingest")
		}
	} else if c.AllowInsecureSMTP {
		if !loopbackListener(c.SMTPListenAddress) {
			return errors.New("insecure SMTP is only allowed on a loopback listener")
		}
	} else if c.MXHostname == "" || c.SMTPTLSCertFile == "" || c.SMTPTLSKeyFile == "" {
		return errors.New("MX hostname and SMTP TLS certificate/key paths are required")
	}
	if c.MaxMessageBytes <= 0 || c.MaxMessageBytes > DefaultMaxMessageBytes {
		return errors.New("max message size must be between 1 byte and 25 MiB")
	}
	return nil
}

func CanonicalReceiveAddress(address string) (string, error) {
	address = strings.TrimSpace(address)
	if strings.Count(address, "@") != 1 {
		return "", errors.New("expected one plain addr-spec")
	}
	parts := strings.SplitN(address, "@", 2)
	local, domain := parts[0], strings.ToLower(strings.TrimSuffix(parts[1], "."))
	if len(local) > 64 || !localPartPattern.MatchString(local) || strings.Contains(local, "..") || strings.HasSuffix(local, ".") {
		return "", errors.New("local part must be lowercase ASCII and cannot contain consecutive dots")
	}
	if len(domain) == 0 || len(domain) > 253 || !strings.Contains(domain, ".") {
		return "", errors.New("domain must be a valid DNS name")
	}
	for _, label := range strings.Split(domain, ".") {
		if !domainLabelPattern.MatchString(label) {
			return "", errors.New("domain must be a valid ASCII DNS name")
		}
	}
	return local + "@" + domain, nil
}

func loopbackListener(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func envDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func envBool(key string) (bool, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return false, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s: expected a boolean", key)
	}
	return parsed, nil
}

func splitNonempty(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	var result []string
	for _, part := range strings.Split(value, ",") {
		if part = strings.TrimSpace(part); part != "" {
			result = append(result, part)
		}
	}
	return result
}
