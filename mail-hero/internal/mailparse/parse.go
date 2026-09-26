// Package mailparse turns an untrusted RFC 5322 message into bounded, JSON-ready
// display data. The original message remains the source of truth for downloads.
package mailparse

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/emersion/go-message"
	_ "github.com/emersion/go-message/charset"
	messageMail "github.com/emersion/go-message/mail"
)

const (
	MaxRawBytes     = 25 << 20
	MaxHeaderBytes  = 256 << 10
	MaxDecodedBytes = 50 << 20
	MaxTextBytes    = 2 << 20
	MaxDepth        = 20
	MaxParts        = 200
)

var (
	ErrLimit       = errors.New("mail exceeds parser limit")
	ErrMalformed   = errors.New("malformed mail")
	ErrNotFound    = errors.New("attachment not found")
	ErrNotDownload = errors.New("part is not an attachment")
)

type Address struct {
	Address string `json:"address"`
	Name    string `json:"name"`
}

type Header struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type AttachmentMeta struct {
	PartID      string `json:"part_id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
}

// Message contains only derived display data. HTML has passed a strict
// allowlist; callers must still render it in a sandboxed, network-blocked frame.
type Message struct {
	Subject      string           `json:"subject"`
	Text         string           `json:"text"`
	HTML         string           `json:"html"`
	From         []Address        `json:"from"`
	To           []Address        `json:"to"`
	Cc           []Address        `json:"cc"`
	ReplyTo      []Address        `json:"reply_to"`
	SentAt       *time.Time       `json:"sent_at"`
	RFCMessageID *string          `json:"rfc_message_id"`
	Headers      []Header         `json:"headers"`
	Attachments  []AttachmentMeta `json:"attachments"`
	NeedsReview  bool             `json:"needs_review"`
	Warnings     []string         `json:"warnings"`
}

// Download is an individual decoded attachment. Data is bounded by the
// accepted SMTP message size and MaxDecodedBytes; HTTP owns response headers.
type Download struct {
	Filename    string
	ContentType string
	Data        []byte
}

type scanner struct {
	ctx       context.Context
	decoded   int64
	parts     int
	message   Message
	requested string
	download  *Download
	foundPart bool
}

type content struct {
	plain string
	html  string
}

// Parse decodes a complete SMTP DATA message. It never truncates content to
// make it appear deliverable: a broken or oversized MIME tree returns an error
// while the caller keeps the immutable raw message for manual inspection.
func Parse(raw []byte) (Message, error) {
	return ParseContext(context.Background(), raw)
}

// ParseContext is Parse with cancellation during MIME reads and traversal.
func ParseContext(ctx context.Context, raw []byte) (Message, error) {
	s, root, err := newScanner(ctx, raw, "")
	if err != nil {
		return Message{}, err
	}
	s.readHeaders(root)
	body, err := s.walk(root, 0, "1")
	if err != nil {
		return Message{}, err
	}
	s.message.HTML = sanitizeHTML(body.html)
	if len(s.message.HTML) > MaxTextBytes {
		return Message{}, fmt.Errorf("%w: sanitized HTML", ErrLimit)
	}
	s.message.Text = strings.TrimSpace(body.plain)
	if s.message.Text == "" && body.html != "" {
		s.message.Text = htmlText(s.message.HTML)
	}
	if len(s.message.Text) > MaxTextBytes {
		return Message{}, fmt.Errorf("%w: extracted text", ErrLimit)
	}
	if !utf8.ValidString(s.message.Text) {
		return Message{}, fmt.Errorf("%w: invalid text encoding", ErrMalformed)
	}
	if s.message.Text == "" && s.message.Subject == "" {
		s.warn("no_readable_body")
	}
	return s.message, nil
}

// Attachment reparses the stored raw message and returns only a MIME part
// which the parser classified as an attachment. partID is the stable path
// published in Message.Attachments, for example "1.2".
func Attachment(raw []byte, partID string) (Download, error) {
	return AttachmentContext(context.Background(), raw, partID)
}

// AttachmentContext is Attachment with cancellation during MIME reads.
func AttachmentContext(ctx context.Context, raw []byte, partID string) (Download, error) {
	if !validPartID(partID) {
		return Download{}, ErrNotFound
	}
	s, root, err := newScanner(ctx, raw, partID)
	if err != nil {
		return Download{}, err
	}
	if _, err := s.walk(root, 0, "1"); err != nil {
		return Download{}, err
	}
	if !s.foundPart {
		return Download{}, ErrNotFound
	}
	if s.download == nil {
		return Download{}, ErrNotDownload
	}
	return *s.download, nil
}

func newScanner(ctx context.Context, raw []byte, requested string) (*scanner, *message.Entity, error) {
	if ctx == nil {
		return nil, nil, fmt.Errorf("%w: nil context", ErrMalformed)
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if len(raw) == 0 {
		return nil, nil, fmt.Errorf("%w: empty message", ErrMalformed)
	}
	if len(raw) > MaxRawBytes {
		return nil, nil, fmt.Errorf("%w: raw message", ErrLimit)
	}
	if firstHeaderEnd(raw) > MaxHeaderBytes {
		return nil, nil, fmt.Errorf("%w: message header", ErrLimit)
	}
	root, err := message.ReadWithOptions(contextReader{ctx: ctx, Reader: bytes.NewReader(raw)}, &message.ReadOptions{MaxHeaderBytes: MaxHeaderBytes})
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, ctx.Err()
		}
		return nil, nil, fmt.Errorf("%w: header or encoding", ErrMalformed)
	}
	return &scanner{ctx: ctx, requested: requested, message: Message{
		From: []Address{}, To: []Address{}, Cc: []Address{}, ReplyTo: []Address{},
		Headers: []Header{}, Attachments: []AttachmentMeta{}, Warnings: []string{},
	}}, root, nil
}

func (s *scanner) readHeaders(root *message.Entity) {
	h := messageMail.Header{Header: root.Header}
	subject, err := h.Subject()
	s.message.Subject = strings.ToValidUTF8(subject, "�")
	if err != nil {
		s.warn("subject_decode_failed")
	}
	s.message.From = s.addresses(&h, "From")
	s.message.To = s.addresses(&h, "To")
	s.message.Cc = s.addresses(&h, "Cc")
	s.message.ReplyTo = s.addresses(&h, "Reply-To")
	if date, err := h.Date(); err == nil && !date.IsZero() {
		u := date.UTC()
		s.message.SentAt = &u
	} else if root.Header.Has("Date") {
		s.warn("date_decode_failed")
	}
	if id, err := h.MessageID(); err == nil && id != "" {
		s.message.RFCMessageID = &id
	} else if err != nil {
		s.warn("message_id_decode_failed")
	}
	fields := root.Header.Fields()
	for fields.Next() {
		value, err := fields.Text()
		if err != nil {
			s.warn("header_decode_failed")
		}
		s.message.Headers = append(s.message.Headers, Header{
			Key:   strings.ToValidUTF8(fields.Key(), "�"),
			Value: strings.ToValidUTF8(value, "�"),
		})
	}
}

func (s *scanner) addresses(h *messageMail.Header, key string) []Address {
	result := []Address{}
	items, err := h.AddressList(key)
	if err != nil {
		s.warn("address_decode_failed")
		return result
	}
	for _, item := range items {
		if item != nil {
			result = append(result, Address{
				Address: strings.ToValidUTF8(item.Address, "�"),
				Name:    strings.ToValidUTF8(item.Name, "�"),
			})
		}
	}
	return result
}

func (s *scanner) warn(code string) {
	s.message.NeedsReview = true
	for _, old := range s.message.Warnings {
		if old == code {
			return
		}
	}
	s.message.Warnings = append(s.message.Warnings, code)
}

func (s *scanner) walk(entity *message.Entity, depth int, path string) (content, error) {
	if err := s.ctx.Err(); err != nil {
		return content{}, err
	}
	if depth > MaxDepth {
		return content{}, fmt.Errorf("%w: MIME depth", ErrLimit)
	}
	s.parts++
	if s.parts > MaxParts {
		return content{}, fmt.Errorf("%w: MIME parts", ErrLimit)
	}
	if s.requested == path {
		s.foundPart = true
	}
	var headerBytes int64
	fields := entity.Header.Fields()
	for fields.Next() {
		headerBytes += int64(len(fields.Key()) + len(fields.Value()) + 4)
		if headerBytes > MaxHeaderBytes {
			return content{}, fmt.Errorf("%w: MIME part header", ErrLimit)
		}
	}
	mediaType := "text/plain"
	var typeParams map[string]string
	if entity.Header.Has("Content-Type") {
		var err error
		mediaType, typeParams, err = entity.Header.ContentType()
		if err != nil {
			return content{}, fmt.Errorf("%w: MIME content type", ErrMalformed)
		}
	}
	if mediaType == "" {
		mediaType = "text/plain"
	}
	mediaType = strings.ToLower(mediaType)
	var disposition string
	var dispositionParams map[string]string
	if entity.Header.Has("Content-Disposition") {
		var err error
		disposition, dispositionParams, err = entity.Header.ContentDisposition()
		if err != nil {
			return content{}, fmt.Errorf("%w: MIME disposition", ErrMalformed)
		}
	}
	filename := dispositionParams["filename"]
	if filename == "" {
		filename = typeParams["name"]
	}
	filename = cleanFilename(filename)
	attachment := disposition == "attachment" || filename != "" || (!strings.HasPrefix(mediaType, "multipart/") && mediaType != "text/plain" && mediaType != "text/html")
	if strings.HasPrefix(mediaType, "multipart/") && !attachment {
		mr := entity.MultipartReader()
		if mr == nil {
			return content{}, fmt.Errorf("%w: missing MIME boundary", ErrMalformed)
		}
		defer mr.Close()
		var result content
		childCount := 0
		for {
			part, err := mr.NextPart()
			if s.ctx.Err() != nil {
				return content{}, s.ctx.Err()
			}
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return content{}, fmt.Errorf("%w: MIME part", ErrMalformed)
			}
			childCount++
			child, err := s.walk(part, depth+1, path+"."+strconv.Itoa(childCount))
			if err != nil {
				return content{}, err
			}
			if mediaType == "multipart/alternative" {
				// A plain and an HTML part are alternate representations.
				if result.plain == "" && child.plain != "" {
					result.plain = child.plain
				}
				if result.html == "" && child.html != "" {
					result.html = child.html
				}
			} else {
				result.plain = joinText(result.plain, child.plain)
				if result.html == "" {
					result.html = child.html
				}
			}
		}
		return result, nil
	}
	if mediaType == "message/rfc822" || mediaType == "application/ms-tnef" || mediaType == "application/vnd.ms-tnef" {
		s.warn("attached_or_opaque_message")
	}
	if attachment {
		if filename == "" {
			filename = "attachment-" + strings.ReplaceAll(path, ".", "-")
			if mediaType == "message/rfc822" {
				filename += ".eml"
			}
		}
		var target io.Writer = io.Discard
		var buf bytes.Buffer
		if s.requested == path {
			target = &buf
		}
		size, err := s.readBody(entity.Body, target, MaxDecodedBytes)
		if err != nil {
			return content{}, err
		}
		s.message.Attachments = append(s.message.Attachments, AttachmentMeta{
			PartID: path, Filename: filename, ContentType: mediaType, Size: size,
		})
		if s.requested == path {
			s.download = &Download{Filename: filename, ContentType: mediaType, Data: buf.Bytes()}
		}
		return content{}, nil
	}
	var buf bytes.Buffer
	if _, err := s.readBody(entity.Body, &buf, MaxTextBytes); err != nil {
		return content{}, err
	}
	if !utf8.Valid(buf.Bytes()) {
		return content{}, fmt.Errorf("%w: invalid UTF-8 text", ErrMalformed)
	}
	if mediaType == "text/html" {
		return content{html: buf.String()}, nil
	}
	return content{plain: buf.String()}, nil
}

func (s *scanner) readBody(r io.Reader, out io.Writer, partLimit int64) (int64, error) {
	remaining := int64(MaxDecodedBytes) - s.decoded
	if remaining < 0 {
		return 0, fmt.Errorf("%w: decoded message", ErrLimit)
	}
	limit := min(remaining, partLimit)
	n, err := io.Copy(out, io.LimitReader(contextReader{ctx: s.ctx, Reader: r}, limit+1))
	s.decoded += n
	if err != nil {
		if s.ctx.Err() != nil {
			return 0, s.ctx.Err()
		}
		return 0, fmt.Errorf("%w: MIME body", ErrMalformed)
	}
	if n > limit {
		return 0, fmt.Errorf("%w: decoded MIME body", ErrLimit)
	}
	return n, nil
}

type contextReader struct {
	ctx context.Context
	io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

func firstHeaderEnd(raw []byte) int {
	end := bytes.Index(raw, []byte("\r\n\r\n"))
	if end < 0 {
		end = bytes.Index(raw, []byte("\n\n"))
	}
	if end < 0 {
		return len(raw)
	}
	return end
}

func joinText(a, b string) string {
	if b == "" {
		return a
	}
	if a == "" {
		return b
	}
	return strings.TrimRight(a, "\r\n") + "\n\n" + strings.TrimLeft(b, "\r\n")
}

func cleanFilename(name string) string {
	name = strings.ToValidUTF8(name, "�")
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	name = strings.TrimSpace(name)
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return '_'
		}
		return r
	}, name)
	if name == "." || name == ".." {
		return ""
	}
	if len(name) > 255 {
		name = string([]rune(name)[:min(120, utf8.RuneCountInString(name))])
	}
	return name
}

func validPartID(id string) bool {
	if id == "" {
		return false
	}
	for _, item := range strings.Split(id, ".") {
		n, err := strconv.Atoi(item)
		if err != nil || n < 1 || strconv.Itoa(n) != item {
			return false
		}
	}
	return true
}
