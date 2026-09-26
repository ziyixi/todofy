package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/ziyixi/mail-hero/internal/delivery"
	"github.com/ziyixi/mail-hero/internal/mailparse"
)

type messageListItem struct {
	ID               string     `json:"id"`
	Subject          string     `json:"subject"`
	From             string     `json:"from"`
	ReceivedAt       time.Time  `json:"received_at"`
	ParseState       string     `json:"parse_state"`
	DeliveryState    string     `json:"delivery_state"`
	HasAttachment    bool       `json:"has_attachment"`
	SizeBytes        int64      `json:"size_bytes"`
	ReadAt           *time.Time `json:"read_at"`
	Preview          string     `json:"preview"`
	ContentDeletedAt *time.Time `json:"content_deleted_at"`
}

type pageCursor struct {
	Time time.Time `json:"time"`
	ID   string    `json:"id"`
}

func encodeCursor(c pageCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}
func decodeCursor(raw string) (pageCursor, error) {
	var c pageCursor
	if raw == "" {
		return c, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(b, &c)
	if err != nil || c.Time.IsZero() || c.ID == "" {
		return c, errors.New("invalid cursor")
	}
	return c, nil
}

func (s *Server) listMessages(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	limit := 50
	if raw := query.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			badRequest(w, "limit 超出范围")
			return
		}
		limit = n
	}
	cursor, err := decodeCursor(query.Get("cursor"))
	if err != nil {
		badRequest(w, "cursor 无效")
		return
	}
	q := strings.TrimSpace(query.Get("q"))
	if len(q) > 200 {
		badRequest(w, "搜索词过长")
		return
	}
	status := query.Get("status")
	parseState := query.Get("parse_state")
	attach := query.Get("has_attachment")
	var hasAttachment *bool
	if attach != "" {
		v, err := strconv.ParseBool(attach)
		if err != nil {
			badRequest(w, "has_attachment 无效")
			return
		}
		hasAttachment = &v
	}
	var after, before *time.Time
	for _, part := range []struct {
		raw    string
		target **time.Time
	}{{query.Get("received_after"), &after}, {query.Get("received_before"), &before}} {
		if part.raw != "" {
			v, err := time.Parse(time.RFC3339, part.raw)
			if err != nil {
				badRequest(w, "时间参数无效")
				return
			}
			*part.target = &v
		}
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT m.id::text,COALESCE(m.subject,''),COALESCE(m.from_text,''),m.received_at,m.parse_state,m.size_bytes,m.read_at,m.has_attachment,m.content_deleted_at,
 COALESCE(left(m.search_text,160),''),COALESCE((SELECT state FROM deliveries WHERE message_id=m.id ORDER BY generation DESC LIMIT 1),'unarranged')
 FROM messages m WHERE m.origin IN ('smtp','cloudflare') AND ($1::text='' OR m.subject ILIKE '%'||$1||'%' OR m.from_text ILIKE '%'||$1||'%' OR m.search_text ILIKE '%'||$1||'%')
 AND ($2::text='' OR m.parse_state=$2)
 AND ($3::boolean IS NULL OR m.has_attachment=$3)
 AND ($4::timestamptz IS NULL OR m.received_at>=$4)
 AND ($5::timestamptz IS NULL OR m.received_at<=$5)
 AND ($6::timestamptz IS NULL OR (m.received_at,m.id)<($6,$7::uuid))
 AND ($8::text='' OR COALESCE((SELECT state FROM deliveries WHERE message_id=m.id ORDER BY generation DESC LIMIT 1),'unarranged')=$8)
 ORDER BY m.received_at DESC,m.id DESC LIMIT $9`, q, parseState, hasAttachment, after, before, nullableTime(cursor.Time), nullableString(cursor.ID), status, limit+1)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	items := []messageListItem{}
	for rows.Next() {
		var item messageListItem
		if err = rows.Scan(&item.ID, &item.Subject, &item.From, &item.ReceivedAt, &item.ParseState, &item.SizeBytes, &item.ReadAt, &item.HasAttachment, &item.ContentDeletedAt, &item.Preview, &item.DeliveryState); err != nil {
			serverError(w, err)
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		serverError(w, rows.Err())
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		next = encodeCursor(pageCursor{Time: last.ReceivedAt, ID: last.ID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": next})
}
func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}
func nullableString(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func (s *Server) getMessage(w http.ResponseWriter, r *http.Request) {
	var id, subject, from, envelopeFrom, envelopeTo, parseState string
	var received, lastReceived time.Time
	var parsed []byte
	var size, version int64
	var arrivalCount int
	var readAt, deleted *time.Time
	err := s.Pool.QueryRow(r.Context(), `SELECT id::text,COALESCE(subject,''),COALESCE(from_text,''),envelope_from,envelope_recipient,parse_state,received_at,last_received_at,arrival_count,parsed_json,size_bytes,version,read_at,content_deleted_at FROM messages WHERE id=$1 AND origin IN ('smtp','cloudflare')`, r.PathValue("id")).Scan(&id, &subject, &from, &envelopeFrom, &envelopeTo, &parseState, &received, &lastReceived, &arrivalCount, &parsed, &size, &version, &readAt, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		notFound(w)
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	var body mailparse.Message
	if len(parsed) > 0 {
		if err = json.Unmarshal(parsed, &body); err != nil {
			serverError(w, err)
			return
		}
	}
	var latest string
	err = s.Pool.QueryRow(r.Context(), `SELECT COALESCE((SELECT state FROM deliveries WHERE message_id=$1 ORDER BY generation DESC LIMIT 1),'unarranged')`, id).Scan(&latest)
	if err != nil {
		serverError(w, err)
		return
	}
	deliveries, err := s.messageDeliveries(r, id)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"message": map[string]any{"id": id, "subject": subject, "from": from, "to": body.To, "cc": body.Cc, "reply_to": body.ReplyTo, "text": body.Text, "html": body.HTML, "headers": body.Headers, "attachments": body.Attachments, "warnings": body.Warnings, "sent_at": body.SentAt, "rfc_message_id": body.RFCMessageID, "envelope_from": envelopeFrom, "envelope_to": envelopeTo, "parse_state": parseState, "delivery_state": latest, "version": version, "received_at": received, "last_received_at": lastReceived, "arrival_count": arrivalCount, "size_bytes": size, "content_deleted_at": deleted, "read_at": readAt}, "deliveries": deliveries})
}
func (s *Server) patchMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Version int64 `json:"version"`
		Read    bool  `json:"read"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Version < 1 {
		badRequest(w, "version/read 无效")
		return
	}
	var readAt *time.Time
	now := time.Now().UTC()
	if body.Read {
		readAt = &now
	}
	tag, err := s.Pool.Exec(r.Context(), `UPDATE messages SET read_at=$3,version=version+1 WHERE id=$1 AND version=$2 AND origin IN ('smtp','cloudflare')`, r.PathValue("id"), body.Version, readAt)
	if err != nil {
		serverError(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		conflict(w, "邮件已改变，请刷新")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"read_at": readAt, "version": body.Version + 1})
}
func (s *Server) rawBytes(r *http.Request) ([]byte, error) {
	var raw []byte
	var deleted *time.Time
	err := s.Pool.QueryRow(r.Context(), `SELECT raw,content_deleted_at FROM messages WHERE id=$1 AND origin IN ('smtp','cloudflare')`, r.PathValue("id")).Scan(&raw, &deleted)
	if err != nil {
		return nil, err
	}
	if deleted != nil || raw == nil {
		return nil, delivery.ErrGone
	}
	return raw, nil
}
func (s *Server) rawMessage(w http.ResponseWriter, r *http.Request) {
	raw, err := s.rawBytes(r)
	if err != nil {
		handleContentError(w, err)
		return
	}
	w.Header().Set("Content-Type", "message/rfc822")
	w.Header().Set("Content-Disposition", `attachment; filename="mail-hero-message.eml"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(raw)
}
func (s *Server) attachment(w http.ResponseWriter, r *http.Request) {
	raw, err := s.rawBytes(r)
	if err != nil {
		handleContentError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	downloaded, err := mailparse.AttachmentContext(ctx, raw, r.PathValue("part_id"))
	if err != nil {
		notFound(w)
		return
	}
	name := downloaded.Filename
	if name == "" {
		name = "attachment"
	}
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": name})
	if disposition == "" {
		disposition = `attachment; filename="attachment"`
	}
	w.Header().Set("Content-Type", downloaded.ContentType)
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(downloaded.Data)
}
func handleContentError(w http.ResponseWriter, err error) {
	if errors.Is(err, delivery.ErrGone) {
		writeError(w, http.StatusGone, "content_deleted", "邮件内容已删除", requestID(w))
		return
	}
	if errors.Is(err, pgx.ErrNoRows) {
		notFound(w)
		return
	}
	serverError(w, err)
}
func (s *Server) sendMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		EndpointID      string `json:"endpoint_id"`
		ActionRequestID string `json:"action_request_id"`
	}
	if err := decodeJSON(r, &body); err != nil || body.EndpointID == "" {
		badRequest(w, "endpoint_id/action_request_id 必填")
		return
	}
	id, err := s.Delivery.CreateManual(r.Context(), r.Context().Value(ownerKey).(string), body.ActionRequestID, r.PathValue("id"), body.EndpointID, "", 0)
	if err != nil {
		handleActionError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"event_id": id})
}
func (s *Server) reparseMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ActionRequestID string `json:"action_request_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "请求格式无效")
		return
	}
	owner := r.Context().Value(ownerKey).(string)
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	hash := s.Delivery.ActionHash("reparse", r.PathValue("id"))
	previous, err := s.Delivery.ReserveAction(r.Context(), tx, owner, body.ActionRequestID, "reparse", r.PathValue("id"), hash)
	if err != nil {
		badRequest(w, "操作 ID 无效或冲突")
		return
	}
	if previous != "" {
		if err = tx.Commit(r.Context()); err != nil {
			serverError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"status": "pending"})
		return
	}
	tag, err := tx.Exec(r.Context(), `UPDATE messages SET parse_state='pending',parse_error=NULL,version=version+1 WHERE id=$1 AND origin IN ('smtp','cloudflare') AND raw IS NOT NULL AND content_deleted_at IS NULL AND parse_state IN ('ready','failed') AND NOT EXISTS(SELECT 1 FROM deliveries WHERE message_id=$1)`, r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	if tag.RowsAffected() != 1 {
		conflict(w, "该邮件暂不能重新解析")
		return
	}
	if err = delivery.FinishAction(r.Context(), tx, owner, body.ActionRequestID, r.PathValue("id"), 202); err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "pending"})
}
func (s *Server) deleteContent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Version         int64  `json:"version"`
		ActionRequestID string `json:"action_request_id"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Version < 1 {
		badRequest(w, "version/action_request_id 无效")
		return
	}
	owner := r.Context().Value(ownerKey).(string)
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	hash := s.Delivery.ActionHash("delete_content", r.PathValue("id"), fmt.Sprint(body.Version))
	previous, err := s.Delivery.ReserveAction(r.Context(), tx, owner, body.ActionRequestID, "delete_content", r.PathValue("id"), hash)
	if err != nil {
		badRequest(w, "操作 ID 无效或冲突")
		return
	}
	if previous != "" {
		if err = tx.Commit(r.Context()); err != nil {
			serverError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
		return
	}
	var bytesMessage, bytesPayload, bytesPreview int64
	err = tx.QueryRow(r.Context(), `SELECT COALESCE(octet_length(raw),0)+COALESCE(octet_length(parsed_json::text),0)+COALESCE(octet_length(subject),0)+COALESCE(octet_length(from_text),0)+COALESCE(octet_length(search_text),0),COALESCE((SELECT sum(octet_length(payload)) FROM deliveries WHERE message_id=m.id),0),COALESCE((SELECT sum(octet_length(a.response_preview)) FROM delivery_attempts a JOIN deliveries d ON d.event_id=a.event_id WHERE d.message_id=m.id),0) FROM messages m WHERE id=$1 AND version=$2 AND content_deleted_at IS NULL FOR UPDATE`, r.PathValue("id"), body.Version).Scan(&bytesMessage, &bytesPayload, &bytesPreview)
	if errors.Is(err, pgx.ErrNoRows) {
		conflict(w, "邮件已改变，请刷新")
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE messages SET raw=NULL,parsed_json=NULL,subject=NULL,from_text=NULL,search_text=NULL,envelope_from='',envelope_recipient='',has_attachment=false,content_deleted_at=now(),version=version+1 WHERE id=$1`, r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE deliveries SET payload=NULL,state=CASE WHEN state IN ('pending','retry_wait','failed') THEN 'cancelled' ELSE state END,last_error=CASE WHEN state IN ('pending','retry_wait') THEN 'content_deleted' ELSE last_error END WHERE message_id=$1`, r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE delivery_attempts SET response_preview=NULL WHERE event_id IN (SELECT event_id FROM deliveries WHERE message_id=$1)`, r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE app_settings SET logical_bytes=GREATEST(0,logical_bytes-$1) WHERE id=1`, bytesMessage+bytesPayload+bytesPreview)
	if err != nil {
		serverError(w, err)
		return
	}
	if err = delivery.FinishAction(r.Context(), tx, owner, body.ActionRequestID, r.PathValue("id"), 200); err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}
