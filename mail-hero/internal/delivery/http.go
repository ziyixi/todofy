package delivery

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var ErrTargetBlocked = errors.New("endpoint target is blocked by network policy")

func ValidateTargetURL(raw string, allowedInternal []string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return ErrTargetBlocked
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return ErrTargetBlocked
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if _, err = strconv.Atoi(port); err != nil {
		return ErrTargetBlocked
	}
	allowed := internalAllowed(net.JoinHostPort(host, port), allowedInternal)
	if u.Scheme == "http" && !allowed {
		return ErrTargetBlocked
	}
	if ip := net.ParseIP(host); ip != nil && forbiddenIP(ip) && !allowed {
		return ErrTargetBlocked
	}
	if host == "localhost" && !allowed {
		return ErrTargetBlocked
	}
	return nil
}

func internalAllowed(hostport string, allowed []string) bool {
	for _, value := range allowed {
		if strings.EqualFold(strings.TrimSpace(value), hostport) {
			return true
		}
	}
	return false
}

func forbiddenIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast()
}

// post uses a fresh transport per request. Its dialer validates and pins the
// resolved destination IP, preventing DNS rebinding between checks and connect.
func Post(ctx context.Context, target, authType, credential, eventID string, payload []byte, allowed []string, timeout time.Duration) (int, string, string, error) {
	if err := ValidateTargetURL(target, allowed); err != nil {
		return 0, "", "target_blocked", err
	}
	u, _ := url.Parse(target)
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	allowedHost := internalAllowed(net.JoinHostPort(host, port), allowed)
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 0}
	transport := &http.Transport{DisableKeepAlives: true, MaxIdleConns: 0}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		requestHost, requestPort, err := net.SplitHostPort(addr)
		if err != nil || !strings.EqualFold(requestHost, host) || requestPort != port {
			return nil, ErrTargetBlocked
		}
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, requestHost)
		if err != nil {
			return nil, err
		}
		for _, resolved := range addresses {
			ip := resolved.IP
			if forbiddenIP(ip) && !allowedHost {
				continue
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), requestPort))
		}
		return nil, ErrTargetBlocked
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, strings.NewReader(string(payload)))
	if err != nil {
		return 0, "", "request_invalid", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", eventID)
	switch authType {
	case "none":
	case "bearer":
		req.Header.Set("Authorization", "Bearer "+credential)
	case "basic":
		username, password, ok := strings.Cut(credential, ":")
		if !ok {
			return 0, "", "credential_invalid", errors.New("basic credential must contain username:password")
		}
		req.SetBasicAuth(username, password)
	default:
		return 0, "", "credential_invalid", errors.New("invalid auth type")
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", "network_error", err
	}
	defer resp.Body.Close()
	preview := ""
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if (strings.HasPrefix(contentType, "text/plain") || strings.HasPrefix(contentType, "application/json")) && resp.StatusCode >= 300 {
		limited, readErr := io.ReadAll(io.LimitReader(resp.Body, 2048))
		if readErr == nil {
			preview = strings.ToValidUTF8(string(limited), "�")
			if credential != "" {
				preview = strings.ReplaceAll(preview, credential, "[redacted]")
				if authType == "basic" {
					username, password, _ := strings.Cut(credential, ":")
					if password != "" {
						preview = strings.ReplaceAll(preview, password, "[redacted]")
					}
					if username != "" {
						preview = strings.ReplaceAll(preview, username, "[redacted]")
					}
				}
			}
			if len(preview) > 2048 {
				preview = strings.ToValidUTF8(preview[:2048], "")
			}
		}
	}
	retryAfter := resp.Header.Get("Retry-After")
	return resp.StatusCode, preview, retryAfter, nil
}

func RetryAfter(raw string, now time.Time) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	if seconds, err := strconv.ParseInt(raw, 10, 64); err == nil {
		if seconds < 0 {
			return time.Time{}, fmt.Errorf("negative Retry-After")
		}
		// Values beyond our supported pause window are handled by the worker as
		// a configuration issue. Avoid overflowing time.Duration on hostile input.
		if seconds > int64((24 * time.Hour).Seconds()) {
			return now.Add(25 * time.Hour), nil
		}
		return now.Add(time.Duration(seconds) * time.Second), nil
	}
	allDigits := raw != ""
	for _, char := range raw {
		if char < '0' || char > '9' {
			allDigits = false
			break
		}
	}
	if allDigits {
		return now.Add(25 * time.Hour), nil
	}
	parsed, err := http.ParseTime(raw)
	if err != nil {
		return time.Time{}, err
	}
	if parsed.Before(now) {
		return now, nil
	}
	return parsed, nil
}
