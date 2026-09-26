package smtp

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	stdsmtp "net/smtp"
	"net/textproto"
	"sync"
	"testing"
	"time"

	gosmtp "github.com/emersion/go-smtp"
	"github.com/ziyixi/mail-hero/internal/config"
	"github.com/ziyixi/mail-hero/internal/store"
)

type recordingReceiver struct {
	mu     sync.Mutex
	inputs []store.IngestInput
	err    error
}

func (r *recordingReceiver) Ingest(_ context.Context, input store.IngestInput) (store.IngestResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.inputs = append(r.inputs, input)
	return store.IngestResult{MessageID: "test", ArrivalCount: 1}, r.err
}

func (r *recordingReceiver) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.inputs)
}

func TestSMTPAcceptsOnlyConfiguredRecipientAndCommitsBefore250(t *testing.T) {
	receiver := &recordingReceiver{}
	_, listener := startTestServer(t, receiver)

	client, err := stdsmtp.Dial(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Mail(""); err != nil { // Legal null reverse-path.
		t.Fatal(err)
	}
	if err := client.Rcpt("other@in.example.org"); err == nil {
		t.Fatal("unknown recipient was accepted")
	}
	if err := client.Rcpt("hero@in.example.org"); err != nil {
		t.Fatal(err)
	}
	if err := client.Rcpt("hero@IN.EXAMPLE.ORG"); err != nil {
		t.Fatal(err)
	}
	writer, err := client.Data()
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte("From: sender@example.org\r\nSubject: Synthetic\r\n\r\nOnly a test.\r\n")
	if _, err := writer.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil { // Final 250 follows Receiver.Ingest's return.
		t.Fatal(err)
	}
	if receiver.count() != 1 {
		t.Fatalf("expected one durable ingest, got %d", receiver.count())
	}
	receiver.mu.Lock()
	got := receiver.inputs[0]
	receiver.mu.Unlock()
	if got.Recipient != "hero@in.example.org" || got.EnvelopeFrom != "" || !bytes.Equal(got.Raw, raw) {
		t.Fatalf("unexpected committed envelope or bytes: recipient=%q from=%q raw=%q", got.Recipient, got.EnvelopeFrom, got.Raw)
	}
}

func TestSMTPTemporaryFailureWhenCommitFails(t *testing.T) {
	receiver := &recordingReceiver{err: errors.New("database offline")}
	_, listener := startTestServer(t, receiver)
	client, err := stdsmtp.Dial(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Mail("sender@example.org"); err != nil {
		t.Fatal(err)
	}
	if err := client.Rcpt("hero@in.example.org"); err != nil {
		t.Fatal(err)
	}
	w, err := client.Data()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("Subject: Failed\r\n\r\nSynthetic\r\n")); err != nil {
		t.Fatal(err)
	}
	err = w.Close()
	var status *textproto.Error
	if !errors.As(err, &status) || status.Code != 451 {
		t.Fatalf("expected temporary 451 after failed commit, got %v", err)
	}
}

func TestSMTPExactLimitAcceptedAndNextByteRejected(t *testing.T) {
	receiver := &recordingReceiver{}
	_, listener := startTestServerWithLimit(t, receiver, 128)
	client, err := stdsmtp.Dial(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	for _, test := range []struct {
		size int
		want int
	}{{128, 0}, {129, 552}} {
		if err := client.Mail("sender@example.org"); err != nil {
			t.Fatal(err)
		}
		if err := client.Rcpt("hero@in.example.org"); err != nil {
			t.Fatal(err)
		}
		writer, err := client.Data()
		if err != nil {
			t.Fatal(err)
		}
		body := append(bytes.Repeat([]byte("X"), test.size-2), '\r', '\n')
		if _, err := writer.Write(body); err != nil {
			t.Fatal(err)
		}
		err = writer.Close()
		if test.want == 0 {
			if err != nil {
				t.Fatalf("exact size was rejected: %v", err)
			}
		} else {
			var status *textproto.Error
			if !errors.As(err, &status) || status.Code != test.want {
				t.Fatalf("size %d expected %d, got %v", test.size, test.want, err)
			}
		}
	}
	if receiver.count() != 1 {
		t.Fatalf("expected only exact-size message to persist, got %d", receiver.count())
	}
}

func TestDataRejectsPartialAndOversizeWithoutIngest(t *testing.T) {
	receiver := &recordingReceiver{}
	entry := &backend{receiver: receiver, address: "hero@in.example.org", maxBytes: 10, ingest: make(chan struct{}, 1)}
	s := &session{backend: entry}
	if err := s.Mail("sender@example.org", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Rcpt("hero@in.example.org", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Data(&brokenReader{}); err == nil {
		t.Fatal("incomplete DATA was accepted")
	}
	if err := s.Data(bytes.NewReader([]byte("12345678901"))); !errors.Is(err, gosmtp.ErrDataTooLarge) {
		t.Fatalf("expected 552 size rejection, got %v", err)
	}
	if receiver.count() != 0 {
		t.Fatalf("bad DATA reached storage %d times", receiver.count())
	}
}

func TestConcurrentDataIsTemporarilyRejectedBeforeBuffering(t *testing.T) {
	receiver := &blockingReceiver{started: make(chan struct{}), release: make(chan struct{})}
	entry := &backend{receiver: receiver, address: "hero@in.example.org", maxBytes: 1024, ingest: make(chan struct{}, 1)}
	first := &session{backend: entry, recipient: entry.address}
	second := &session{backend: entry, recipient: entry.address}
	firstResult := make(chan error, 1)
	go func() { firstResult <- first.Data(bytes.NewReader([]byte("first"))) }()
	select {
	case <-receiver.started:
	case <-time.After(time.Second):
		t.Fatal("first message did not enter durable ingest")
	}
	err := second.Data(bytes.NewReader([]byte("second")))
	var status *gosmtp.SMTPError
	if !errors.As(err, &status) || status.Code != 451 {
		t.Fatalf("expected temporary busy rejection, got %v", err)
	}
	close(receiver.release)
	if err := <-firstResult; err != nil {
		t.Fatalf("first ingest failed: %v", err)
	}
}

type blockingReceiver struct {
	started chan struct{}
	release chan struct{}
}

func (r *blockingReceiver) Ingest(_ context.Context, _ store.IngestInput) (store.IngestResult, error) {
	close(r.started)
	<-r.release
	return store.IngestResult{}, nil
}

type brokenReader struct{ sent bool }

func (r *brokenReader) Read(p []byte) (int, error) {
	if !r.sent {
		r.sent = true
		return copy(p, "partial"), io.ErrUnexpectedEOF
	}
	return 0, io.ErrUnexpectedEOF
}

func startTestServer(t *testing.T, receiver Receiver) (*Server, net.Listener) {
	return startTestServerWithLimit(t, receiver, 1024)
}

func startTestServerWithLimit(t *testing.T, receiver Receiver, maxBytes int64) (*Server, net.Listener) {
	t.Helper()
	server, err := NewServer(config.Config{
		ReceiveAddress:    "hero@in.example.org",
		SMTPListenAddress: "127.0.0.1:0",
		AllowInsecureSMTP: true,
		MaxMessageBytes:   maxBytes,
	}, receiver)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	t.Cleanup(func() {
		server.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("SMTP server did not shut down")
		}
	})
	return server, listener
}
