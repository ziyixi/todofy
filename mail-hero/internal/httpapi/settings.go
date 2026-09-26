package httpapi

import (
	"crypto/hmac"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type settingsJSON struct {
	Version             int64      `json:"version"`
	Mode                string     `json:"mode"`
	CurrentEndpointID   *string    `json:"current_endpoint_id"`
	SendPaused          bool       `json:"send_paused"`
	EffectiveSendPaused bool       `json:"effective_send_paused"`
	RetentionDays       *int       `json:"retention_days"`
	ReceiveAddress      string     `json:"receive_address"`
	LogicalBytes        int64      `json:"logical_bytes"`
	LogicalLimitBytes   int64      `json:"logical_limit_bytes"`
	LastBackupAt        *time.Time `json:"last_backup_at"`
}

func (s *Server) currentSettings(r *http.Request) (settingsJSON, error) {
	var v settingsJSON
	err := s.Pool.QueryRow(r.Context(), `SELECT version,mode,current_endpoint_id::text,send_paused,retention_days,logical_bytes,logical_limit_bytes,last_backup_at FROM app_settings WHERE id=1`).Scan(&v.Version, &v.Mode, &v.CurrentEndpointID, &v.SendPaused, &v.RetentionDays, &v.LogicalBytes, &v.LogicalLimitBytes, &v.LastBackupAt)
	v.ReceiveAddress = s.Cfg.ReceiveAddress
	v.EffectiveSendPaused = v.SendPaused || s.Cfg.ForceSendPaused
	return v, err
}
func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	v, err := s.currentSettings(r)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *Server) retentionToken(owner string, version int64, days int, issuedAt time.Time) string {
	var raw [40]byte
	binary.BigEndian.PutUint64(raw[:8], uint64(issuedAt.Unix()))
	sum := s.Delivery.ActionHash("retention_preview", owner, fmt.Sprint(version), fmt.Sprint(days), fmt.Sprint(issuedAt.Unix()))
	copy(raw[8:], sum)
	return base64.RawURLEncoding.EncodeToString(raw[:])
}

func (s *Server) validRetentionToken(token, owner string, version int64, days int, now time.Time) bool {
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 40 {
		return false
	}
	issuedAt := time.Unix(int64(binary.BigEndian.Uint64(raw[:8])), 0)
	if issuedAt.After(now.Add(time.Minute)) || now.Sub(issuedAt) > 10*time.Minute {
		return false
	}
	want := s.Delivery.ActionHash("retention_preview", owner, fmt.Sprint(version), fmt.Sprint(days), fmt.Sprint(issuedAt.Unix()))
	return hmac.Equal(raw[8:], want)
}

func (s *Server) retentionPreview(w http.ResponseWriter, r *http.Request) {
	days, err := strconv.Atoi(r.URL.Query().Get("days"))
	if err != nil || days < 1 || days > 3650 {
		badRequest(w, "保留天数无效")
		return
	}
	settings, err := s.currentSettings(r)
	if err != nil {
		serverError(w, err)
		return
	}
	var candidates, bytesToClear int64
	err = s.Pool.QueryRow(r.Context(), `SELECT count(*),COALESCE(sum(
	 COALESCE(octet_length(m.raw),0)+COALESCE(octet_length(m.parsed_json::text),0)
	 +COALESCE(octet_length(m.subject),0)+COALESCE(octet_length(m.from_text),0)+COALESCE(octet_length(m.search_text),0)
	 +COALESCE((SELECT sum(octet_length(d.payload)) FROM deliveries d WHERE d.message_id=m.id),0)
	 +COALESCE((SELECT sum(octet_length(a.response_preview)) FROM delivery_attempts a JOIN deliveries d ON d.event_id=a.event_id WHERE d.message_id=m.id),0)
	 ),0) FROM messages m WHERE m.origin IN ('smtp','cloudflare') AND m.content_deleted_at IS NULL AND m.parse_state='ready'
	 AND m.received_at<now()-$1::int*interval '1 day'
	 AND (m.receive_mode='archive' OR EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.state='delivered'))
	 AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.message_id=m.id AND d.state<>'delivered')`, days).Scan(&candidates, &bytesToClear)
	if err != nil {
		serverError(w, err)
		return
	}
	now := time.Now().UTC()
	writeJSON(w, http.StatusOK, map[string]any{"version": settings.Version, "days": days, "candidates": candidates, "bytes_to_clear": bytesToClear, "preview_token": s.retentionToken(r.Context().Value(ownerKey).(string), settings.Version, days, now), "expires_at": now.Add(10 * time.Minute)})
}

func (s *Server) patchSettings(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Version           int64           `json:"version"`
		Mode              *string         `json:"mode"`
		CurrentEndpointID json.RawMessage `json:"current_endpoint_id"`
		SendPaused        *bool           `json:"send_paused"`
		RetentionDays     json.RawMessage `json:"retention_days"`
		RetentionConfirm  string          `json:"retention_confirmation"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "设置格式无效")
		return
	}
	if body.Version <= 0 {
		badRequest(w, "version 必填")
		return
	}
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var mode string
	var endpointID *string
	var paused bool
	var retention *int
	err = tx.QueryRow(r.Context(), `SELECT mode,current_endpoint_id::text,send_paused,retention_days FROM app_settings WHERE id=1 FOR UPDATE`).Scan(&mode, &endpointID, &paused, &retention)
	if err != nil {
		serverError(w, err)
		return
	}
	if body.Mode != nil {
		mode = *body.Mode
	}
	if body.CurrentEndpointID != nil {
		if string(body.CurrentEndpointID) == "null" {
			endpointID = nil
		} else {
			var id string
			if err = json.Unmarshal(body.CurrentEndpointID, &id); err != nil || id == "" {
				badRequest(w, "目标 ID 无效")
				return
			}
			endpointID = &id
		}
	}
	if body.SendPaused != nil {
		paused = *body.SendPaused
	}
	previousRetention := retention
	if body.RetentionDays != nil {
		if string(body.RetentionDays) == "null" {
			retention = nil
		} else {
			var days int
			if err = json.Unmarshal(body.RetentionDays, &days); err != nil || days < 1 || days > 3650 {
				badRequest(w, "保留天数无效")
				return
			}
			retention = &days
		}
	}
	if retention != nil && (previousRetention == nil || *retention < *previousRetention) && !s.validRetentionToken(body.RetentionConfirm, r.Context().Value(ownerKey).(string), body.Version, *retention, time.Now()) {
		badRequest(w, "缩短保留期前需要预览并确认")
		return
	}
	if mode != "archive" && mode != "forward" {
		badRequest(w, "mode 只能为 archive 或 forward")
		return
	}
	if mode == "forward" && endpointID == nil {
		badRequest(w, "自动投递需要先选择 webhook 目标")
		return
	}
	if endpointID != nil {
		var exists bool
		err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM webhook_endpoints WHERE id=$1 AND archived_at IS NULL AND current_revision_id IS NOT NULL)`, *endpointID).Scan(&exists)
		if err != nil {
			badRequest(w, "目标 ID 无效")
			return
		}
		if !exists {
			badRequest(w, "目标不存在")
			return
		}
	}
	var version int64
	err = tx.QueryRow(r.Context(), `UPDATE app_settings SET mode=$2,current_endpoint_id=$3,send_paused=$4,retention_days=$5,version=version+1,updated_at=now() WHERE id=1 AND version=$1 RETURNING version`, body.Version, mode, endpointID, paused, retention).Scan(&version)
	if errors.Is(err, pgx.ErrNoRows) {
		conflict(w, "设置已被修改，请刷新后重试")
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		serverError(w, err)
		return
	}
	s.getSettings(w, r)
}
func (s *Server) overview(w http.ResponseWriter, r *http.Request) {
	var total, pending, failed, delivered, dbBytes int64
	err := s.Pool.QueryRow(r.Context(), `SELECT
 (SELECT count(*) FROM messages WHERE origin IN ('smtp','cloudflare')),
 (SELECT count(*) FROM deliveries WHERE state IN ('pending','retry_wait','sending')),
 (SELECT count(*) FROM deliveries WHERE state='failed'),
 (SELECT count(*) FROM deliveries WHERE state='delivered'),
 pg_database_size(current_database())`).Scan(&total, &pending, &failed, &delivered, &dbBytes)
	if err != nil {
		serverError(w, err)
		return
	}
	settings, err := s.currentSettings(r)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"receive_address": s.Cfg.ReceiveAddress, "counts": map[string]int64{"messages": total, "pending": pending, "failed": failed, "delivered": delivered}, "storage": map[string]int64{"logical_bytes": settings.LogicalBytes, "limit_bytes": settings.LogicalLimitBytes, "database_bytes": dbBytes}, "backup": map[string]any{"last_at": settings.LastBackupAt}, "send_paused": settings.EffectiveSendPaused})
}
func (s *Server) setupStatus(w http.ResponseWriter, r *http.Request) {
	if s.Cfg.IngestTransport == "cloudflare" {
		var last *time.Time
		if err := s.Pool.QueryRow(r.Context(), `SELECT max(received_at) FROM messages WHERE origin='cloudflare'`).Scan(&last); err != nil {
			serverError(w, err)
			return
		}
		received := "pending"
		detail := "尚未看到从 Cloudflare 成功写入本机的邮件；请在转发后检查。"
		if last != nil {
			received = "ok"
			detail = "已有邮件经接收接口写入本机 PostgreSQL。"
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ingest_transport": "cloudflare",
			"receive_address":  s.Cfg.ReceiveAddress,
			"address_valid":    true,
			"last_received_at": last,
			"checks": []map[string]string{
				{"id": "local", "label": "内网接收接口", "status": "ok", "detail": "Cloudflare 模式和接收凭据已加载；公网路由需另外验证。"},
				{"id": "edge", "label": "Cloudflare 路由与暂存", "status": "pending", "detail": "本机无法仅凭配置判断 Email Routing、Worker、R2 是否已部署。"},
				{"id": "received", "label": "本机已收到邮件", "status": received, "detail": detail},
			},
		})
		return
	}
	domain := ""
	if at := strings.LastIndex(s.Cfg.ReceiveAddress, "@"); at >= 0 {
		domain = s.Cfg.ReceiveAddress[at+1:]
	}
	mx, err := net.LookupMX(domain)
	mxConfigured := false
	if err == nil {
		for _, record := range mx {
			if strings.EqualFold(strings.TrimSuffix(record.Host, "."), s.Cfg.MXHostname) {
				mxConfigured = true
				break
			}
		}
	}
	var last *time.Time
	err = s.Pool.QueryRow(r.Context(), `SELECT max(received_at) FROM messages WHERE origin='smtp'`).Scan(&last)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ingest_transport": "smtp", "receive_address": s.Cfg.ReceiveAddress, "address_valid": true, "mx_configured": mxConfigured, "smtp_external": "not_verified", "last_received_at": last, "starttls_configured": !s.Cfg.AllowInsecureSMTP})
}
