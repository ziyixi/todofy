package smtp

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	gosmtp "github.com/emersion/go-smtp"
	"github.com/ziyixi/mail-hero/internal/config"
	"github.com/ziyixi/mail-hero/internal/store"
)

const (
	maxConnections   = 10
	maxRCPTCommands  = 10
	readWriteTimeout = 60 * time.Second
	maxSessionTime   = 5 * time.Minute
	commitTimeout    = 5 * time.Second
)

// Receiver is the durable storage boundary: its successful return must mean
// that raw DATA, envelope, snapshot and pending parse state were committed.
type Receiver interface {
	Ingest(context.Context, store.IngestInput) (store.IngestResult, error)
}

type Server struct {
	server *gosmtp.Server
	config config.Config
	entry  *backend
}

func NewServer(cfg config.Config, receiver Receiver) (*Server, error) {
	if receiver == nil {
		return nil, errors.New("SMTP receiver is required")
	}
	address, err := config.CanonicalReceiveAddress(cfg.ReceiveAddress)
	if err != nil {
		return nil, fmt.Errorf("receive address: %w", err)
	}
	if cfg.MaxMessageBytes == 0 {
		cfg.MaxMessageBytes = config.DefaultMaxMessageBytes
	}
	if cfg.MaxMessageBytes <= 0 || cfg.MaxMessageBytes > config.DefaultMaxMessageBytes {
		return nil, errors.New("SMTP message size must be between 1 byte and 25 MiB")
	}
	if cfg.SMTPListenAddress == "" {
		cfg.SMTPListenAddress = ":2525"
	}
	entry := &backend{
		receiver: receiver,
		address:  address,
		maxBytes: cfg.MaxMessageBytes,
		ingest:   make(chan struct{}, 1),
	}
	base := gosmtp.NewServer(entry)
	base.Addr = cfg.SMTPListenAddress
	base.Domain = cfg.MXHostname
	if base.Domain == "" {
		base.Domain = strings.SplitN(address, "@", 2)[1]
	}
	base.MaxRecipients = maxRCPTCommands
	// go-smtp's dataReader returns ErrDataTooLarge before testing the final dot
	// when exactly MaxMessageBytes were read. Advertise one extra byte and enforce
	// the actual size in Session.Mail/Data so an exactly-25-MiB mail is accepted.
	base.MaxMessageBytes = cfg.MaxMessageBytes + 1
	base.ReadTimeout = readWriteTimeout
	base.WriteTimeout = readWriteTimeout
	base.EnableSMTPUTF8 = false
	base.EnableDSN = false
	base.EnableBINARYMIME = false
	base.EnableREQUIRETLS = false

	if cfg.SMTPTLSCertFile != "" || cfg.SMTPTLSKeyFile != "" {
		if cfg.SMTPTLSCertFile == "" || cfg.SMTPTLSKeyFile == "" {
			return nil, errors.New("both SMTP TLS certificate and key paths are required")
		}
		certificate, err := tls.LoadX509KeyPair(cfg.SMTPTLSCertFile, cfg.SMTPTLSKeyFile)
		if err != nil {
			return nil, fmt.Errorf("load SMTP TLS certificate: %w", err)
		}
		leaf := certificate.Leaf
		if leaf == nil {
			leaf, err = x509.ParseCertificate(certificate.Certificate[0])
			if err != nil {
				return nil, errors.New("invalid SMTP TLS leaf certificate")
			}
		}
		if !cfg.AllowInsecureSMTP {
			now := time.Now()
			if now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) {
				return nil, errors.New("SMTP TLS certificate is not currently valid")
			}
			if err := leaf.VerifyHostname(cfg.MXHostname); err != nil {
				return nil, errors.New("SMTP TLS certificate does not match MX hostname")
			}
		}
		base.TLSConfig = &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}
	} else if !cfg.AllowInsecureSMTP || !isLoopback(cfg.SMTPListenAddress) {
		return nil, errors.New("public SMTP listener requires STARTTLS certificate and key")
	}
	return &Server{server: base, config: cfg, entry: entry}, nil
}

func (s *Server) ListenAndServe() error {
	listener, err := net.Listen("tcp", s.config.SMTPListenAddress)
	if err != nil {
		return err
	}
	return s.Serve(listener)
}

func (s *Server) Serve(listener net.Listener) error {
	return s.server.Serve(&limitedListener{Listener: listener, slots: make(chan struct{}, maxConnections)})
}

func (s *Server) Shutdown(ctx context.Context) error { return s.server.Shutdown(ctx) }

func (s *Server) Close() error { return s.server.Close() }

type backend struct {
	receiver Receiver
	address  string
	maxBytes int64
	ingest   chan struct{}
}

func (b *backend) NewSession(*gosmtp.Conn) (gosmtp.Session, error) {
	return &session{backend: b}, nil
}

type session struct {
	backend      *backend
	from         string
	recipient    string
	rcptCommands int
}

func (s *session) Mail(from string, opts *gosmtp.MailOptions) error {
	if opts != nil && opts.Size > s.backend.maxBytes {
		return gosmtp.ErrDataTooLarge
	}
	s.Reset()
	s.from = from
	return nil
}

func (s *session) Rcpt(to string, _ *gosmtp.RcptOptions) error {
	s.rcptCommands++
	if s.rcptCommands > maxRCPTCommands {
		return &gosmtp.SMTPError{Code: 452, EnhancedCode: gosmtp.EnhancedCode{4, 5, 3}, Message: "Too many recipients"}
	}
	canonical, err := config.CanonicalReceiveAddress(to)
	if err != nil || canonical != s.backend.address {
		return &gosmtp.SMTPError{Code: 550, EnhancedCode: gosmtp.EnhancedCode{5, 1, 1}, Message: "Unknown recipient"}
	}
	s.recipient = s.backend.address
	return nil
}

func (s *session) Data(reader io.Reader) error {
	if s.recipient == "" {
		return &gosmtp.SMTPError{Code: 503, EnhancedCode: gosmtp.EnhancedCode{5, 5, 1}, Message: "Recipient required"}
	}
	select {
	case s.backend.ingest <- struct{}{}:
		defer func() { <-s.backend.ingest }()
	default:
		return &gosmtp.SMTPError{Code: 451, EnhancedCode: gosmtp.EnhancedCode{4, 3, 2}, Message: "Receiver is busy; retry later"}
	}
	var raw bytes.Buffer
	if n, err := io.Copy(&raw, io.LimitReader(reader, s.backend.maxBytes+1)); err != nil {
		return &gosmtp.SMTPError{Code: 451, EnhancedCode: gosmtp.EnhancedCode{4, 4, 2}, Message: "Incomplete message; retry later"}
	} else if n > s.backend.maxBytes {
		return gosmtp.ErrDataTooLarge
	}
	ctx, cancel := context.WithTimeout(context.Background(), commitTimeout)
	defer cancel()
	_, err := s.backend.receiver.Ingest(ctx, store.IngestInput{
		EnvelopeFrom: s.from,
		Recipient:    s.recipient,
		Raw:          raw.Bytes(),
	})
	if err == nil {
		return nil
	}
	if errors.Is(err, store.ErrCapacity) {
		return &gosmtp.SMTPError{Code: 452, EnhancedCode: gosmtp.EnhancedCode{4, 3, 1}, Message: "Receiver storage full; retry later"}
	}
	if errors.Is(err, store.ErrInvalidMessage) {
		return &gosmtp.SMTPError{Code: 552, EnhancedCode: gosmtp.EnhancedCode{5, 3, 4}, Message: "Message cannot be accepted"}
	}
	return &gosmtp.SMTPError{Code: 451, EnhancedCode: gosmtp.EnhancedCode{4, 3, 0}, Message: "Receiver temporarily unavailable; retry later"}
}

func (s *session) Reset() {
	s.from = ""
	s.recipient = ""
	s.rcptCommands = 0
}

func (s *session) Logout() error { return nil }

type limitedListener struct {
	net.Listener
	slots chan struct{}
}

func (l *limitedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			return &limitedConn{Conn: conn, release: func() { <-l.slots }, deadline: time.Now().Add(maxSessionTime)}, nil
		default:
			conn.SetWriteDeadline(time.Now().Add(time.Second))
			io.WriteString(conn, "421 4.3.2 Too many SMTP connections; retry later\r\n")
			conn.Close()
		}
	}
}

type limitedConn struct {
	net.Conn
	release  func()
	once     sync.Once
	deadline time.Time
}

func (c *limitedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.release)
	return err
}

func (c *limitedConn) SetDeadline(t time.Time) error {
	return c.Conn.SetDeadline(c.cap(t))
}

func (c *limitedConn) SetReadDeadline(t time.Time) error {
	return c.Conn.SetReadDeadline(c.cap(t))
}

func (c *limitedConn) SetWriteDeadline(t time.Time) error {
	return c.Conn.SetWriteDeadline(c.cap(t))
}

func (c *limitedConn) cap(t time.Time) time.Time {
	if t.IsZero() || c.deadline.Before(t) {
		return c.deadline
	}
	return t
}

func isLoopback(address string) bool {
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
