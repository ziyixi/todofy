package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"time"

	"github.com/ziyixi/mail-hero/internal/config"
	"github.com/ziyixi/mail-hero/internal/store"
)

const maxIngestMetadataHeader = 2048

var cloudflareIngestID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type ingestMetadata struct {
	From       string    `json:"from"`
	To         string    `json:"to"`
	ReceivedAt time.Time `json:"received_at"`
	SizeBytes  *int64    `json:"size_bytes"`
}

// ingestEmail acknowledges only after PostgreSQL has committed the raw MIME,
// envelope, routing snapshot and external ID receipt in one transaction.
func (s *Server) ingestEmail(w http.ResponseWriter, r *http.Request) {
	if s.Cfg.IngestTransport != "cloudflare" {
		notFound(w)
		return
	}
	id := r.Header.Get("X-Mail-Hero-Ingest-Id")
	if !cloudflareIngestID.MatchString(id) {
		badRequest(w, "接收 ID 无效")
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "message/rfc822" {
		badRequest(w, "邮件内容类型无效")
		return
	}
	encoded := r.Header.Get("X-Mail-Hero-Metadata")
	if encoded == "" || len(encoded) > maxIngestMetadataHeader {
		badRequest(w, "邮件元信息无效")
		return
	}
	metadataBytes, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		badRequest(w, "邮件元信息无效")
		return
	}
	var metadata ingestMetadata
	if err = json.Unmarshal(metadataBytes, &metadata); err != nil || metadata.ReceivedAt.IsZero() || metadata.SizeBytes == nil || *metadata.SizeBytes < 0 {
		badRequest(w, "邮件元信息无效")
		return
	}
	recipient, err := config.CanonicalReceiveAddress(metadata.To)
	if err != nil || recipient != s.Cfg.ReceiveAddress {
		writeError(w, http.StatusUnprocessableEntity, "wrong_recipient", "收件地址不匹配", requestID(w))
		return
	}
	maxBytes := s.Cfg.MaxMessageBytes
	if maxBytes == 0 {
		maxBytes = config.DefaultMaxMessageBytes
	}
	if *metadata.SizeBytes > maxBytes || r.ContentLength > maxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "message_too_large", "邮件超过大小限制", requestID(w))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	defer r.Body.Close()
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "message_too_large", "邮件超过大小限制", requestID(w))
			return
		}
		w.Header().Set("Retry-After", "30")
		serverError(w, err)
		return
	}
	if int64(len(raw)) != *metadata.SizeBytes {
		w.Header().Set("Retry-After", "30")
		writeError(w, http.StatusServiceUnavailable, "incomplete_body", "邮件传输不完整，请重试", requestID(w))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	_, err = store.FromPool(s.Pool).Ingest(ctx, store.IngestInput{
		EnvelopeFrom: metadata.From,
		Recipient:    recipient,
		Raw:          raw,
		Origin:       "cloudflare",
		ExternalID:   id,
		ReceivedAt:   metadata.ReceivedAt,
	})
	if err != nil {
		switch {
		case errors.Is(err, store.ErrIngestConflict):
			conflict(w, "接收 ID 已用于其他邮件")
		case errors.Is(err, store.ErrInvalidMessage), errors.Is(err, store.ErrInvalidRecipient):
			writeError(w, http.StatusUnprocessableEntity, "invalid_message", "邮件数据无效", requestID(w))
		default:
			w.Header().Set("Retry-After", "60")
			serverError(w, err)
		}
		return
	}
	w.Header().Set("X-Mail-Hero-Ingest-Id", id)
	w.WriteHeader(http.StatusNoContent)
}
