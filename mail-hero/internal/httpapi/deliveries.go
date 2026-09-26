package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/ziyixi/mail-hero/internal/delivery"
)

type deliveryItem struct {
	EventID         string     `json:"event_id"`
	MessageID       string     `json:"message_id"`
	EndpointID      string     `json:"endpoint_id"`
	Subject         string     `json:"subject"`
	From            string     `json:"from"`
	EndpointLabel   string     `json:"endpoint_label"`
	EndpointURL     string     `json:"endpoint_url"`
	State           string     `json:"state"`
	EffectiveState  string     `json:"effective_state"`
	AttemptCount    int        `json:"attempt_count"`
	CreatedAt       time.Time  `json:"created_at"`
	NextAttemptAt   time.Time  `json:"next_attempt_at"`
	DeliveredAt     *time.Time `json:"delivered_at"`
	LastError       *string    `json:"last_error"`
	Generation      int        `json:"generation"`
	ReplayOfEventID *string    `json:"replay_of_event_id"`
	RetryMode       string     `json:"retry_mode"`
	ContentDeleted  bool       `json:"content_deleted"`
}

func scanDelivery(row pgx.Row) (deliveryItem, error) {
	var v deliveryItem
	var endpointPaused, globalPaused bool
	var blocked *string
	err := row.Scan(&v.EventID, &v.MessageID, &v.EndpointID, &v.Subject, &v.From, &v.EndpointLabel, &v.EndpointURL, &v.State, &v.AttemptCount, &v.CreatedAt, &v.NextAttemptAt, &v.DeliveredAt, &v.LastError, &v.Generation, &v.ReplayOfEventID, &v.RetryMode, &v.ContentDeleted, &endpointPaused, &globalPaused, &blocked)
	v.EffectiveState = v.State
	if v.State == "pending" || v.State == "retry_wait" {
		if endpointPaused || globalPaused || blocked != nil {
			v.EffectiveState = "paused"
		}
	}
	return v, err
}

const deliverySelect = `SELECT d.event_id::text,d.message_id::text,e.id::text,COALESCE(m.subject,''),COALESCE(m.from_text,''),e.label,r.url,d.state,d.attempt_count,d.created_at,d.next_attempt_at,d.delivered_at,d.last_error,d.generation,d.replay_of_event_id::text,d.retry_mode,m.content_deleted_at IS NOT NULL,e.paused,s.send_paused,r.blocked_reason
 FROM deliveries d JOIN messages m ON m.id=d.message_id JOIN endpoint_revisions r ON r.id=d.endpoint_revision_id JOIN webhook_endpoints e ON e.id=r.endpoint_id JOIN app_settings s ON s.id=1`

func (s *Server) messageDeliveries(r *http.Request, id string) ([]deliveryItem, error) {
	rows, err := s.Pool.Query(r.Context(), deliverySelect+` WHERE d.message_id=$1 ORDER BY d.generation DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []deliveryItem{}
	for rows.Next() {
		v, e := scanDelivery(rows)
		if e != nil {
			return nil, e
		}
		if s.Cfg.ForceSendPaused && (v.State == "pending" || v.State == "retry_wait") {
			v.EffectiveState = "paused"
		}
		items = append(items, v)
	}
	return items, rows.Err()
}
func (s *Server) listDeliveries(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := 50
	if text := q.Get("limit"); text != "" {
		n, err := strconv.Atoi(text)
		if err != nil || n < 1 || n > 100 {
			badRequest(w, "limit 超出范围")
			return
		}
		limit = n
	}
	cursor, err := decodeCursor(q.Get("cursor"))
	if err != nil {
		badRequest(w, "cursor 无效")
		return
	}
	rows, err := s.Pool.Query(r.Context(), deliverySelect+` WHERE ($1::text='' OR d.state=$1) AND ($2::timestamptz IS NULL OR (d.created_at,d.event_id)<($2,$3::uuid)) ORDER BY d.created_at DESC,d.event_id DESC LIMIT $4`, q.Get("status"), nullableTime(cursor.Time), nullableString(cursor.ID), limit+1)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	items := []deliveryItem{}
	for rows.Next() {
		v, e := scanDelivery(rows)
		if e != nil {
			serverError(w, e)
			return
		}
		if s.Cfg.ForceSendPaused && (v.State == "pending" || v.State == "retry_wait") {
			v.EffectiveState = "paused"
		}
		items = append(items, v)
	}
	if rows.Err() != nil {
		serverError(w, rows.Err())
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		next = encodeCursor(pageCursor{Time: last.CreatedAt, ID: last.EventID})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "next_cursor": next})
}
func (s *Server) getDelivery(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	v, err := scanDelivery(s.Pool.QueryRow(r.Context(), deliverySelect+` WHERE d.event_id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		notFound(w)
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	if s.Cfg.ForceSendPaused && (v.State == "pending" || v.State == "retry_wait") {
		v.EffectiveState = "paused"
	}
	var payload []byte
	var sha []byte
	err = s.Pool.QueryRow(r.Context(), `SELECT payload,payload_sha256 FROM deliveries WHERE event_id=$1`, id).Scan(&payload, &sha)
	if err != nil {
		serverError(w, err)
		return
	}
	rows, err := s.Pool.Query(r.Context(), `SELECT attempt_no,started_at,finished_at,http_status,outcome,error_code,response_preview,credential_key_id FROM delivery_attempts WHERE event_id=$1 ORDER BY attempt_no DESC`, id)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	attempts := []map[string]any{}
	for rows.Next() {
		var no int
		var started time.Time
		var finished *time.Time
		var status *int
		var outcome, errorCode, preview, keyID *string
		if err = rows.Scan(&no, &started, &finished, &status, &outcome, &errorCode, &preview, &keyID); err != nil {
			serverError(w, err)
			return
		}
		attempts = append(attempts, map[string]any{"attempt_no": no, "started_at": started, "finished_at": finished, "http_status": status, "outcome": outcome, "error_code": errorCode, "response_preview": preview, "credential_key_id": keyID})
	}
	if rows.Err() != nil {
		serverError(w, rows.Err())
		return
	}
	var event any
	if len(payload) > 0 {
		if err = json.Unmarshal(payload, &event); err != nil {
			serverError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"delivery": v, "attempts": attempts, "payload": event, "payload_sha256": sha})
}
func handleActionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, delivery.ErrConflict), errors.Is(err, delivery.ErrNotReady):
		conflict(w, "状态已改变或内容尚未准备好，请刷新")
	case errors.Is(err, delivery.ErrGone):
		writeError(w, http.StatusGone, "content_deleted", "邮件内容已删除", requestID(w))
	case errors.Is(err, delivery.ErrExpired):
		conflict(w, "事件重试期限已过")
	case errors.Is(err, pgx.ErrNoRows):
		notFound(w)
	default:
		serverError(w, err)
	}
}
func (s *Server) retryDelivery(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ActionRequestID string `json:"action_request_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "请求格式无效")
		return
	}
	err := s.Delivery.Retry(r.Context(), r.Context().Value(ownerKey).(string), body.ActionRequestID, r.PathValue("id"))
	if err != nil {
		handleActionError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"event_id": r.PathValue("id"), "state": "pending"})
}
func (s *Server) cancelDelivery(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ActionRequestID string `json:"action_request_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "请求格式无效")
		return
	}
	err := s.Delivery.Cancel(r.Context(), r.Context().Value(ownerKey).(string), body.ActionRequestID, r.PathValue("id"))
	if err != nil {
		handleActionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"event_id": r.PathValue("id"), "state": "cancelled"})
}
func (s *Server) replayDelivery(w http.ResponseWriter, r *http.Request) {
	var body struct {
		EndpointID      string `json:"endpoint_id"`
		MessageVersion  int64  `json:"message_version"`
		ActionRequestID string `json:"action_request_id"`
	}
	if err := decodeJSON(r, &body); err != nil || body.EndpointID == "" || body.MessageVersion < 1 {
		badRequest(w, "目标、邮件版本和操作 ID 必填")
		return
	}
	var messageID string
	err := s.Pool.QueryRow(r.Context(), `SELECT message_id::text FROM deliveries WHERE event_id=$1`, r.PathValue("id")).Scan(&messageID)
	if errors.Is(err, pgx.ErrNoRows) {
		notFound(w)
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	eventID, err := s.Delivery.CreateManual(r.Context(), r.Context().Value(ownerKey).(string), body.ActionRequestID, messageID, body.EndpointID, r.PathValue("id"), body.MessageVersion)
	if err != nil {
		handleActionError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"event_id": eventID})
}
