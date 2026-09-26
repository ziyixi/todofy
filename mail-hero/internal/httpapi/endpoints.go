package httpapi

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/ziyixi/mail-hero/internal/delivery"
	"github.com/ziyixi/mail-hero/internal/ids"
	"github.com/ziyixi/mail-hero/internal/mailparse"
)

type endpointJSON struct {
	ID                   string  `json:"id"`
	Label                string  `json:"label"`
	URL                  string  `json:"url"`
	AuthType             string  `json:"auth_type"`
	CredentialConfigured bool    `json:"credential_configured"`
	RatePerMinute        int     `json:"rate_per_minute"`
	TimeoutSeconds       int     `json:"timeout_seconds"`
	Paused               bool    `json:"paused"`
	PausedReason         *string `json:"paused_reason"`
	BlockedReason        *string `json:"blocked_reason"`
	Version              int64   `json:"version"`
	CurrentRevisionID    string  `json:"current_revision_id"`
}

type endpointInput struct {
	Label           *string `json:"label"`
	URL             *string `json:"url"`
	AuthType        *string `json:"auth_type"`
	Credential      *string `json:"credential"`
	RatePerMinute   *int    `json:"rate_per_minute"`
	TimeoutSeconds  *int    `json:"timeout_seconds"`
	Paused          *bool   `json:"paused"`
	Version         int64   `json:"version"`
	ActionRequestID string  `json:"action_request_id"`
}

func (s *Server) listEndpoints(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Pool.Query(r.Context(), `SELECT e.id::text,e.label,r.url,r.auth_type,r.credential_ciphertext IS NOT NULL,e.rate_per_minute,r.timeout_ms/1000,e.paused,e.paused_reason,r.blocked_reason,e.version,r.id::text
 FROM webhook_endpoints e JOIN endpoint_revisions r ON r.id=e.current_revision_id WHERE e.archived_at IS NULL ORDER BY e.created_at DESC`)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	items := []endpointJSON{}
	for rows.Next() {
		var item endpointJSON
		if err = rows.Scan(&item.ID, &item.Label, &item.URL, &item.AuthType, &item.CredentialConfigured, &item.RatePerMinute, &item.TimeoutSeconds, &item.Paused, &item.PausedReason, &item.BlockedReason, &item.Version, &item.CurrentRevisionID); err != nil {
			serverError(w, err)
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		serverError(w, rows.Err())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
func (s *Server) validateEndpoint(in endpointInput, old *endpointJSON) (endpointJSON, string, error) {
	v := endpointJSON{RatePerMinute: 2, TimeoutSeconds: 20, AuthType: "bearer"}
	if old != nil {
		v = *old
	}
	if in.Label != nil {
		v.Label = strings.TrimSpace(*in.Label)
	}
	if in.URL != nil {
		v.URL = strings.TrimSpace(*in.URL)
	}
	if in.AuthType != nil {
		v.AuthType = *in.AuthType
	}
	if in.RatePerMinute != nil {
		v.RatePerMinute = *in.RatePerMinute
	}
	if in.TimeoutSeconds != nil {
		v.TimeoutSeconds = *in.TimeoutSeconds
	}
	if in.Paused != nil {
		v.Paused = *in.Paused
	}
	if len(v.Label) < 1 || len(v.Label) > 120 || v.RatePerMinute < 1 || v.RatePerMinute > 60 || v.TimeoutSeconds < 1 || v.TimeoutSeconds > 120 {
		return v, "", errors.New("名称、频率或超时超出范围")
	}
	if err := delivery.ValidateTargetURL(v.URL, s.Cfg.AllowedInternalTargets); err != nil {
		return v, "", errors.New("目标 URL 不符合出站策略")
	}
	if v.AuthType != "none" && v.AuthType != "bearer" && v.AuthType != "basic" {
		return v, "", errors.New("认证类型无效")
	}
	parsed, _ := url.Parse(v.URL)
	origin, _ := delivery.CredentialOrigin(v.URL)
	if v.AuthType == "none" {
		port := parsed.Port()
		if port == "" {
			if parsed.Scheme == "https" {
				port = "443"
			} else {
				port = "80"
			}
		}
		hp := net.JoinHostPort(strings.ToLower(parsed.Hostname()), port)
		allowed := false
		for _, h := range s.Cfg.AllowedInternalTargets {
			if strings.EqualFold(h, hp) {
				allowed = true
				break
			}
		}
		if !allowed {
			return v, "", errors.New("无认证只允许明确配置的内部目标")
		}
	}
	if in.Credential != nil && len(*in.Credential) > 4096 {
		return v, "", errors.New("认证值过长")
	}
	return v, origin, nil
}

func mayReuseCredential(oldURL, newURL, oldType, newType string) bool {
	if oldType != newType || newType == "none" {
		return false
	}
	oldOrigin, oldErr := delivery.CredentialOrigin(oldURL)
	newOrigin, newErr := delivery.CredentialOrigin(newURL)
	return oldErr == nil && newErr == nil && oldOrigin == newOrigin
}
func (s *Server) createEndpoint(w http.ResponseWriter, r *http.Request) {
	var body endpointInput
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "目标格式无效")
		return
	}
	v, _, err := s.validateEndpoint(body, nil)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	credential := ""
	if body.Credential != nil {
		credential = *body.Credential
	}
	if v.AuthType != "none" && credential == "" {
		badRequest(w, "需要认证值")
		return
	}
	if v.AuthType == "basic" && !strings.Contains(credential, ":") {
		badRequest(w, "Basic 值须为 username:password")
		return
	}
	owner := r.Context().Value(ownerKey).(string)
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	hash := s.Delivery.ActionHash("create_endpoint", v.Label, v.URL, v.AuthType, credential, fmt.Sprint(v.RatePerMinute), fmt.Sprint(v.TimeoutSeconds))
	existing, err := s.Delivery.ReserveAction(r.Context(), tx, owner, body.ActionRequestID, "create_endpoint", "", hash)
	if err != nil {
		badRequest(w, "操作 ID 无效或冲突")
		return
	}
	if existing != "" {
		if err = tx.Commit(r.Context()); err != nil {
			serverError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]string{"id": existing})
		return
	}
	endpointID, err := ids.New()
	if err != nil {
		serverError(w, err)
		return
	}
	revID, err := ids.New()
	if err != nil {
		serverError(w, err)
		return
	}
	var encrypted []byte
	if v.AuthType != "none" {
		encrypted, err = delivery.EncryptCredential(s.Delivery.Key, revID, v.URL, credential)
		if err != nil {
			serverError(w, err)
			return
		}
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO webhook_endpoints(id,label,paused,rate_per_minute) VALUES($1,$2,$3,$4)`, endpointID, v.Label, v.Paused, v.RatePerMinute)
	if err != nil {
		serverError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,credential_key_version,timeout_ms)
 VALUES($1,$2,1,$3,$4,$5,$6,$7)`, revID, endpointID, v.URL, v.AuthType, nullableBytes(encrypted), nullableKeyVersion(encrypted), v.TimeoutSeconds*1000)
	if err != nil {
		serverError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE webhook_endpoints SET current_revision_id=$2 WHERE id=$1`, endpointID, revID)
	if err != nil {
		serverError(w, err)
		return
	}
	if err = delivery.FinishAction(r.Context(), tx, owner, body.ActionRequestID, endpointID, 201); err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": endpointID})
}
func nullableBytes(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}
func nullableKeyVersion(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return 1
}

func (s *Server) patchEndpoint(w http.ResponseWriter, r *http.Request) {
	var body endpointInput
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "目标格式无效")
		return
	}
	if body.Version < 1 {
		badRequest(w, "version 必填")
		return
	}
	id := r.PathValue("id")
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var old endpointJSON
	var oldRevision int
	var oldSecret []byte
	err = tx.QueryRow(r.Context(), `SELECT e.id::text,e.label,r.url,r.auth_type,r.credential_ciphertext IS NOT NULL,e.rate_per_minute,r.timeout_ms/1000,e.paused,e.paused_reason,r.blocked_reason,e.version,r.id::text,r.revision,COALESCE(r.credential_ciphertext,''::bytea)
 FROM webhook_endpoints e JOIN endpoint_revisions r ON r.id=e.current_revision_id WHERE e.id=$1 AND e.archived_at IS NULL FOR UPDATE OF e`, id).Scan(&old.ID, &old.Label, &old.URL, &old.AuthType, &old.CredentialConfigured, &old.RatePerMinute, &old.TimeoutSeconds, &old.Paused, &old.PausedReason, &old.BlockedReason, &old.Version, &old.CurrentRevisionID, &oldRevision, &oldSecret)
	if errors.Is(err, pgx.ErrNoRows) {
		notFound(w)
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	if old.Version != body.Version {
		conflict(w, "目标已改变，请刷新")
		return
	}
	v, _, err := s.validateEndpoint(body, &old)
	if err != nil {
		badRequest(w, err.Error())
		return
	}
	credential := ""
	if body.Credential != nil {
		credential = *body.Credential
	} else if old.CredentialConfigured && mayReuseCredential(old.URL, v.URL, old.AuthType, v.AuthType) {
		credential, err = delivery.DecryptCredential(s.Delivery.Key, old.CurrentRevisionID, old.URL, oldSecret)
		if err != nil {
			serverError(w, err)
			return
		}
	}
	if v.AuthType != "none" && credential == "" {
		badRequest(w, "新 origin 或认证类型需要重新输入认证值")
		return
	}
	if v.AuthType == "basic" && !strings.Contains(credential, ":") {
		badRequest(w, "Basic 值须为 username:password")
		return
	}
	changed := v.URL != old.URL || v.AuthType != old.AuthType || v.TimeoutSeconds != old.TimeoutSeconds || body.Credential != nil
	revisionID := old.CurrentRevisionID
	if changed {
		revisionID, err = ids.New()
		if err != nil {
			serverError(w, err)
			return
		}
		var encrypted []byte
		if v.AuthType != "none" {
			encrypted, err = delivery.EncryptCredential(s.Delivery.Key, revisionID, v.URL, credential)
			if err != nil {
				serverError(w, err)
				return
			}
		}
		_, err = tx.Exec(r.Context(), `INSERT INTO endpoint_revisions(id,endpoint_id,revision,url,auth_type,credential_ciphertext,credential_key_version,timeout_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, revisionID, id, oldRevision+1, v.URL, v.AuthType, nullableBytes(encrypted), nullableKeyVersion(encrypted), v.TimeoutSeconds*1000)
		if err != nil {
			serverError(w, err)
			return
		}
	}
	_, err = tx.Exec(r.Context(), `UPDATE webhook_endpoints SET label=$2,current_revision_id=$3,paused=$4,paused_reason=CASE WHEN $4 THEN paused_reason ELSE NULL END,rate_per_minute=$5,version=version+1,updated_at=now() WHERE id=$1`, id, v.Label, revisionID, v.Paused, v.RatePerMinute)
	if err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "version": old.Version + 1, "current_revision_id": revisionID, "pending_old_revision_unchanged": changed})
}
func (s *Server) rotateCredential(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Credential string `json:"credential"`
		Version    int64  `json:"version"`
	}
	if err := decodeJSON(r, &body); err != nil || body.Credential == "" || body.Version < 1 {
		badRequest(w, "认证值和 version 必填")
		return
	}
	id := r.PathValue("id")
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var currentID, authType, target string
	var version int64
	err = tx.QueryRow(r.Context(), `SELECT e.current_revision_id::text,r.auth_type,r.url,e.version FROM webhook_endpoints e JOIN endpoint_revisions r ON r.id=e.current_revision_id WHERE e.id=$1 FOR UPDATE OF e`, id).Scan(&currentID, &authType, &target, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		notFound(w)
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	if version != body.Version {
		conflict(w, "目标已改变，请刷新")
		return
	}
	if authType == "none" {
		badRequest(w, "无认证目标没有可轮换的凭据")
		return
	}
	if authType == "basic" && !strings.Contains(body.Credential, ":") {
		badRequest(w, "Basic 值须为 username:password")
		return
	}
	origin, _ := delivery.CredentialOrigin(target)
	rows, err := tx.Query(r.Context(), `SELECT id::text,url,auth_type FROM endpoint_revisions WHERE endpoint_id=$1`, id)
	if err != nil {
		serverError(w, err)
		return
	}
	type revision struct{ id, url, auth string }
	list := []revision{}
	for rows.Next() {
		var item revision
		if err = rows.Scan(&item.id, &item.url, &item.auth); err != nil {
			rows.Close()
			serverError(w, err)
			return
		}
		list = append(list, item)
	}
	rows.Close()
	if rows.Err() != nil {
		serverError(w, rows.Err())
		return
	}
	keyID, err := ids.New()
	if err != nil {
		serverError(w, err)
		return
	}
	affected := 0
	for _, item := range list {
		itemOrigin, _ := delivery.CredentialOrigin(item.url)
		if itemOrigin != origin || item.auth != authType {
			continue
		}
		encrypted, encErr := delivery.EncryptCredential(s.Delivery.Key, item.id, item.url, body.Credential)
		if encErr != nil {
			serverError(w, encErr)
			return
		}
		_, err = tx.Exec(r.Context(), `UPDATE endpoint_revisions SET credential_ciphertext=$2,credential_key_version=1,credential_key_id=$3,blocked_reason=CASE WHEN blocked_reason IN ('http_401','http_403','credential_invalid') THEN NULL ELSE blocked_reason END WHERE id=$1`, item.id, encrypted, keyID)
		if err != nil {
			serverError(w, err)
			return
		}
		affected++
	}
	_, err = tx.Exec(r.Context(), `UPDATE webhook_endpoints SET version=version+1,updated_at=now() WHERE id=$1`, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"affected_revisions": affected, "version": version + 1})
}
func (s *Server) checkEndpoint(w http.ResponseWriter, r *http.Request) {
	var target string
	err := s.Pool.QueryRow(r.Context(), `SELECT url FROM endpoint_revisions WHERE id=(SELECT current_revision_id FROM webhook_endpoints WHERE id=$1)`, r.PathValue("id")).Scan(&target)
	if errors.Is(err, pgx.ErrNoRows) {
		notFound(w)
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	if err = delivery.ValidateTargetURL(target, s.Cfg.AllowedInternalTargets); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"url_valid": false, "dns_status": "blocked", "tls_status": "not_checked"})
		return
	}
	parsed, _ := url.Parse(target)
	ips, err := net.DefaultResolver.LookupIP(r.Context(), "ip", parsed.Hostname())
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"url_valid": true, "dns_status": "failed", "tls_status": "not_checked"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"url_valid": true, "dns_status": "resolved", "resolved_count": len(ips), "tls_status": "not_checked", "business_contract": "not_verified"})
}
func (s *Server) testEndpoint(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ActionRequestID string `json:"action_request_id"`
	}
	if err := decodeJSON(r, &body); err != nil {
		badRequest(w, "测试请求格式无效")
		return
	}
	owner := r.Context().Value(ownerKey).(string)
	tx, err := s.Pool.Begin(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	hash := s.Delivery.ActionHash("test_endpoint", r.PathValue("id"))
	existing, err := s.Delivery.ReserveAction(r.Context(), tx, owner, body.ActionRequestID, "test_endpoint", r.PathValue("id"), hash)
	if err != nil {
		badRequest(w, "操作 ID 无效或冲突")
		return
	}
	if existing != "" {
		if err = tx.Commit(r.Context()); err != nil {
			serverError(w, err)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]string{"event_id": existing})
		return
	}
	var revisionID string
	err = tx.QueryRow(r.Context(), `SELECT current_revision_id::text FROM webhook_endpoints WHERE id=$1 AND archived_at IS NULL`, r.PathValue("id")).Scan(&revisionID)
	if errors.Is(err, pgx.ErrNoRows) {
		notFound(w)
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	messageID, _ := ids.New()
	eventID, _ := ids.New()
	raw := []byte("From: Mail Hero <test@example.invalid>\r\nTo: " + s.Cfg.ReceiveAddress + "\r\nSubject: Mail Hero test event\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThis is a synthetic test event.\r\n")
	rawHash := sha256.Sum256(raw)
	ingestKey := sha256.Sum256([]byte("synthetic_test:" + body.ActionRequestID))
	parsed := mailparse.Message{Subject: "Mail Hero test event", Text: "This is a synthetic test event.", From: []mailparse.Address{{Address: "test@example.invalid", Name: "Mail Hero"}}, To: []mailparse.Address{{Address: s.Cfg.ReceiveAddress}}, Attachments: []mailparse.AttachmentMeta{}}
	encoded, _ := json.Marshal(parsed)
	received := time.Now().UTC()
	payload, sum, err := delivery.BuildPayload(eventID, messageID, received, parsed, s.Cfg.ReceiveAddress)
	if err != nil {
		serverError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO messages(id,ingest_key,origin,received_at,last_received_at,envelope_from,envelope_recipient,raw,raw_sha256,size_bytes,receive_mode,endpoint_revision_id,parse_state,parsed_json,parser_version,subject,from_text,search_text)
 VALUES($1,$2,'synthetic_test',$3,$3,'',$4,$5,$6,$7,'archive',$8,'ready',$9,'test',$10,$11,$12)`, messageID, ingestKey[:], received, s.Cfg.ReceiveAddress, raw, rawHash[:], len(raw), revisionID, encoded, parsed.Subject, "test@example.invalid", parsed.Text)
	if err != nil {
		serverError(w, err)
		return
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO deliveries(event_id,message_id,endpoint_revision_id,generation,action_request_id,payload,payload_sha256,state,retry_mode) VALUES($1,$2,$3,1,$4,$5,$6,'pending','once')`, eventID, messageID, revisionID, body.ActionRequestID, payload, sum[:])
	if err != nil {
		serverError(w, err)
		return
	}
	var updatedBytes int64
	err = tx.QueryRow(r.Context(), `WITH amount AS (
	 SELECT octet_length($1::bytea)+octet_length($2::bytea)+octet_length($3::jsonb::text)+octet_length($4::text)+octet_length($5::text)+octet_length($6::text) AS bytes
	) UPDATE app_settings SET logical_bytes=logical_bytes+amount.bytes FROM amount WHERE id=1 AND logical_bytes+amount.bytes<=logical_limit_bytes RETURNING logical_bytes`,
		raw, payload, encoded, parsed.Subject, "test@example.invalid", parsed.Text).Scan(&updatedBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		conflict(w, "内容容量已满，测试事件未创建")
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	if err = delivery.FinishAction(r.Context(), tx, owner, body.ActionRequestID, eventID, 202); err != nil {
		serverError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"event_id": eventID, "synthetic_test": true, "warning": "消费者可能把测试事件当真实邮件处理"})
}
