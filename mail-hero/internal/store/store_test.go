package store

import (
	"crypto/sha256"
	"testing"
)

func TestIngestKeyUsesBytesEnvelopeAndRecipient(t *testing.T) {
	raw := sha256.Sum256([]byte("Message-ID: <same@example.org>\r\n\r\nFirst"))
	key := IngestKey(raw, "Sender@EXAMPLE.ORG", "hero@in.example.org")
	if key != IngestKey(raw, "Sender@EXAMPLE.ORG", "hero@in.example.org") {
		t.Fatal("same message did not produce the same key")
	}
	if key == IngestKey(raw, "sender@EXAMPLE.ORG", "hero@in.example.org") {
		t.Fatal("case-sensitive external local part was collapsed")
	}
	if key == IngestKey(raw, "Sender@EXAMPLE.ORG", "other@in.example.org") {
		t.Fatal("recipient not represented in key")
	}
	if key == IngestKey(sha256.Sum256([]byte("different")), "Sender@EXAMPLE.ORG", "hero@in.example.org") {
		t.Fatal("different raw bytes shared a key")
	}
	from, err := normalizeEnvelopeFrom("Sender@EXAMPLE.ORG")
	if err != nil || from != "Sender@example.org" {
		t.Fatalf("sender normalization: %q, %v", from, err)
	}
}
