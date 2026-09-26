package delivery

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ziyixi/mail-hero/internal/mailparse"
)

var ErrPayloadLimit = errors.New("mail payload exceeds webhook limits or has no subject and text")

type MailEvent struct {
	Type       string       `json:"type"`
	EventID    string       `json:"event_id"`
	ReceivedAt time.Time    `json:"received_at"`
	Message    EventMessage `json:"message"`
}

type EventMessage struct {
	ID           string              `json:"id"`
	From         []mailparse.Address `json:"from"`
	To           []mailparse.Address `json:"to"`
	Subject      string              `json:"subject"`
	SentAt       *time.Time          `json:"sent_at"`
	RFCMessageID *string             `json:"rfc_message_id"`
	Text         string              `json:"text"`
	Attachments  []EventAttachment   `json:"attachments"`
}

type EventAttachment struct {
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

func BuildPayload(eventID, messageID string, receivedAt time.Time, parsed mailparse.Message, receiveAddress string) ([]byte, [32]byte, error) {
	var zero [32]byte
	if !utf8.ValidString(parsed.Text) || !utf8.ValidString(parsed.Subject) || len(parsed.Subject) > 4*1024 || len(parsed.Text) > 256*1024 || len(parsed.From) > 50 || len(parsed.To) > 50 || len(parsed.Attachments) > 100 || (strings.TrimSpace(parsed.Subject) == "" && strings.TrimSpace(parsed.Text) == "") {
		return nil, zero, ErrPayloadLimit
	}
	from := make([]mailparse.Address, 0, len(parsed.From))
	from = append(from, parsed.From...)
	to := make([]mailparse.Address, 0, len(parsed.To))
	for _, a := range parsed.To {
		if !strings.EqualFold(a.Address, receiveAddress) {
			to = append(to, a)
		}
	}
	attachments := make([]EventAttachment, 0, len(parsed.Attachments))
	for _, a := range parsed.Attachments {
		attachments = append(attachments, EventAttachment{Filename: a.Filename, ContentType: a.ContentType, Size: a.Size})
	}
	var sentAt *time.Time
	if parsed.SentAt != nil {
		utc := parsed.SentAt.UTC()
		sentAt = &utc
	}
	event := MailEvent{Type: "mail.received.v1", EventID: eventID, ReceivedAt: receivedAt.UTC(), Message: EventMessage{ID: messageID, From: from, To: to, Subject: parsed.Subject, SentAt: sentAt, RFCMessageID: parsed.RFCMessageID, Text: parsed.Text, Attachments: attachments}}
	raw, err := json.Marshal(event)
	if err != nil {
		return nil, zero, err
	}
	if len(raw) > 1024*1024 {
		return nil, zero, ErrPayloadLimit
	}
	return raw, sha256.Sum256(raw), nil
}
