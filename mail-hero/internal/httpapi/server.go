package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/ziyixi/mail-hero/internal/config"
	"github.com/ziyixi/mail-hero/internal/delivery"
	"github.com/ziyixi/mail-hero/internal/ids"
)

var ingestTokenPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Server struct {
	Cfg         config.Config
	Pool        *pgxpool.Pool
	Delivery    *delivery.Manager
	verifier    *oidc.IDTokenVerifier
	csrfKey     []byte
	ingestToken []byte
	mux         *http.ServeMux
}

type contextKey string

const ownerKey contextKey = "owner"

type apiError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
}

func New(cfg config.Config, pool *pgxpool.Pool, manager *delivery.Manager, secret []byte) (*Server, error) {
	s := &Server{Cfg: cfg, Pool: pool, Delivery: manager, csrfKey: secret, mux: http.NewServeMux()}
	if cfg.IngestTransport == "cloudflare" {
		contents, err := os.ReadFile(cfg.IngestTokenFile)
		if err != nil {
			return nil, errors.New("read Cloudflare ingest token file")
		}
		token := strings.TrimSpace(string(contents))
		if !ingestTokenPattern.MatchString(token) {
			return nil, errors.New("Cloudflare ingest token must be 64 lowercase hex characters")
		}
		s.ingestToken = []byte(token)
	}
	if !cfg.DevAuthBypass {
		issuer := strings.TrimRight(cfg.AccessIssuer, "/")
		keyset := oidc.NewRemoteKeySet(context.Background(), issuer+"/cdn-cgi/access/certs")
		s.verifier = oidc.NewVerifier(issuer, keyset, &oidc.Config{ClientID: cfg.AccessAudience})
	}
	s.routes()
	return s, nil
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID, _ := ids.New()
		w.Header().Set("X-Request-ID", requestID)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
			if r.URL.Path == "/api/v1/ingest/email" {
				if s.Cfg.IngestTransport != "cloudflare" {
					notFound(w)
					return
				}
				const bearer = "Bearer "
				got := r.Header.Get("Authorization")
				if !strings.HasPrefix(got, bearer) || subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(got, bearer)), s.ingestToken) != 1 {
					writeError(w, http.StatusUnauthorized, "unauthorized", "接收凭据无效", requestID)
					return
				}
				s.mux.ServeHTTP(w, r)
				return
			}
			owner, err := s.authenticate(r)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "unauthorized", "请重新登录", requestID)
				return
			}
			if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
				if !s.validCSRF(r, owner) {
					writeError(w, http.StatusForbidden, "csrf_failed", "页面令牌已失效，请刷新后重试", requestID)
					return
				}
			}
			r = r.WithContext(context.WithValue(r.Context(), ownerKey, owner))
		}
		s.mux.ServeHTTP(w, r)
	})
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })
	s.mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := s.Pool.Ping(r.Context()); err != nil {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	s.mux.HandleFunc("GET /api/v1/csrf", s.csrf)
	s.mux.HandleFunc("GET /api/v1/overview", s.overview)
	s.mux.HandleFunc("GET /api/v1/setup/status", s.setupStatus)
	s.mux.HandleFunc("POST /api/v1/ingest/email", s.ingestEmail)
	s.mux.HandleFunc("GET /api/v1/settings", s.getSettings)
	s.mux.HandleFunc("GET /api/v1/settings/retention-preview", s.retentionPreview)
	s.mux.HandleFunc("PATCH /api/v1/settings", s.patchSettings)
	s.mux.HandleFunc("GET /api/v1/messages", s.listMessages)
	s.mux.HandleFunc("GET /api/v1/messages/{id}", s.getMessage)
	s.mux.HandleFunc("PATCH /api/v1/messages/{id}", s.patchMessage)
	s.mux.HandleFunc("GET /api/v1/messages/{id}/raw", s.rawMessage)
	s.mux.HandleFunc("GET /api/v1/messages/{id}/attachments/{part_id}", s.attachment)
	s.mux.HandleFunc("POST /api/v1/messages/{id}/send", s.sendMessage)
	s.mux.HandleFunc("POST /api/v1/messages/{id}/reparse", s.reparseMessage)
	s.mux.HandleFunc("DELETE /api/v1/messages/{id}/content", s.deleteContent)
	s.mux.HandleFunc("GET /api/v1/deliveries", s.listDeliveries)
	s.mux.HandleFunc("GET /api/v1/deliveries/{id}", s.getDelivery)
	s.mux.HandleFunc("POST /api/v1/deliveries/{id}/retry", s.retryDelivery)
	s.mux.HandleFunc("POST /api/v1/deliveries/{id}/cancel", s.cancelDelivery)
	s.mux.HandleFunc("POST /api/v1/deliveries/{id}/replay", s.replayDelivery)
	s.mux.HandleFunc("GET /api/v1/endpoints", s.listEndpoints)
	s.mux.HandleFunc("POST /api/v1/endpoints", s.createEndpoint)
	s.mux.HandleFunc("PATCH /api/v1/endpoints/{id}", s.patchEndpoint)
	s.mux.HandleFunc("POST /api/v1/endpoints/{id}/rotate-credential", s.rotateCredential)
	s.mux.HandleFunc("POST /api/v1/endpoints/{id}/check", s.checkEndpoint)
	s.mux.HandleFunc("POST /api/v1/endpoints/{id}/test", s.testEndpoint)
}

func (s *Server) authenticate(r *http.Request) (string, error) {
	if s.Cfg.DevAuthBypass {
		return "dev-owner", nil
	}
	token := strings.TrimSpace(r.Header.Get("Cf-Access-Jwt-Assertion"))
	if token == "" {
		if cookie, err := r.Cookie("CF_Authorization"); err == nil {
			token = cookie.Value
		}
	}
	if token == "" {
		return "", errors.New("missing Access token")
	}
	verified, err := s.verifier.Verify(r.Context(), token)
	if err != nil {
		return "", err
	}
	var claims struct {
		Email string `json:"email"`
		Sub   string `json:"sub"`
	}
	if err = verified.Claims(&claims); err != nil {
		return "", err
	}
	if !(strings.EqualFold(claims.Email, s.Cfg.AccessOwner) || subtle.ConstantTimeCompare([]byte(claims.Sub), []byte(s.Cfg.AccessOwner)) == 1) {
		return "", errors.New("owner mismatch")
	}
	return s.Cfg.AccessOwner, nil
}

func (s *Server) csrf(w http.ResponseWriter, r *http.Request) {
	owner := r.Context().Value(ownerKey).(string)
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		serverError(w, err)
		return
	}
	nonce := base64.RawURLEncoding.EncodeToString(random)
	exp := time.Now().Add(12 * time.Hour).Unix()
	value := nonce + "." + strconv.FormatInt(exp, 10)
	mac := hmac.New(sha256.New, s.csrfKey)
	mac.Write([]byte(owner + "|" + value))
	token := value + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	http.SetCookie(w, &http.Cookie{Name: "mail_hero_csrf", Value: token, Path: "/api/v1", HttpOnly: true, Secure: !s.Cfg.DevAuthBypass, SameSite: http.SameSiteStrictMode, Expires: time.Unix(exp, 0)})
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

func (s *Server) validCSRF(r *http.Request, owner string) bool {
	origin := r.Header.Get("Origin")
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || !strings.EqualFold(parsed.Host, r.Host) {
		return false
	}
	if s.Cfg.DevAuthBypass {
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return false
		}
	} else if parsed.Scheme != "https" {
		return false
	}
	cookie, err := r.Cookie("mail_hero_csrf")
	if err != nil {
		return false
	}
	token := r.Header.Get("X-CSRF-Token")
	if token == "" || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(token)) != 1 {
		return false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || exp < time.Now().Unix() || exp > time.Now().Add(13*time.Hour).Unix() {
		return false
	}
	mac := hmac.New(sha256.New, s.csrfKey)
	mac.Write([]byte(owner + "|" + parts[0] + "." + parts[1]))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(expected), []byte(parts[2])) == 1
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, code, message, requestID string) {
	writeJSON(w, status, map[string]any{"error": apiError{Code: code, Message: message, RequestID: requestID}})
}
func requestID(w http.ResponseWriter) string { return w.Header().Get("X-Request-ID") }
func serverError(w http.ResponseWriter, _ error) {
	writeError(w, http.StatusServiceUnavailable, "unavailable", "服务暂时不可用", requestID(w))
}
func badRequest(w http.ResponseWriter, message string) {
	writeError(w, http.StatusBadRequest, "invalid_request", message, requestID(w))
}
func conflict(w http.ResponseWriter, message string) {
	writeError(w, http.StatusConflict, "conflict", message, requestID(w))
}
func notFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", "找不到这条记录", requestID(w))
}
func decodeJSON(r *http.Request, out any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}
