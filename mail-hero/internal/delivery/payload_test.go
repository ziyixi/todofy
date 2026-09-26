package delivery

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ziyixi/mail-hero/internal/mailparse"
)

func TestPayloadOmitPrivatePartsAndKeepIdentity(t *testing.T) {
	msg := mailparse.Message{Subject: "hello", Text: "body", To: []mailparse.Address{{Address: "private@in.example.org"}, {Address: "other@example.org"}}, Attachments: []mailparse.AttachmentMeta{{Filename: "file.pdf", ContentType: "application/pdf", Size: 123}}}
	raw, sum, err := BuildPayload("event-1", "message-1", time.Unix(1, 0), msg, "private@in.example.org")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("private@in.example.org")) {
		t.Fatal("capability leaked")
	}
	if bytes.Contains(raw, []byte("file contents")) {
		t.Fatal("attachment bytes leaked")
	}
	var got MailEvent
	if err = json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.EventID != "event-1" || got.Message.ID != "message-1" || len(got.Message.To) != 1 || sum == ([32]byte{}) {
		t.Fatalf("unexpected event: %+v", got)
	}
}
func TestPayloadRejectsLongText(t *testing.T) {
	_, _, err := BuildPayload("e", "m", time.Now(), mailparse.Message{Text: strings.Repeat("x", 256*1024+1)}, "private@in.example.org")
	if err != ErrPayloadLimit {
		t.Fatalf("got %v", err)
	}
}
func TestCredentialAAD(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	sealed, err := EncryptCredential(key, "revision", "https://example.org/hook", "token")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := DecryptCredential(key, "revision", "https://example.org/hook", sealed)
	if err != nil || plain != "token" {
		t.Fatalf("wrong decrypted value: %v", err)
	}
	if _, err = DecryptCredential(key, "other", "https://example.org/hook", sealed); err == nil {
		t.Fatal("revision change should fail")
	}
	if _, err = DecryptCredential(key, "revision", "https://other.example.org/hook", sealed); err == nil {
		t.Fatal("origin change should fail")
	}
}
