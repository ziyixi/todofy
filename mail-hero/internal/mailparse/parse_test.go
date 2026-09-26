package mailparse

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func wire(s string) []byte {
	return []byte(strings.ReplaceAll(s, "\n", "\r\n"))
}

func TestPlainTextDecoding(t *testing.T) {
	raw := wire("From: Sender <sender@example.org>\nTo: Owner <owner@example.org>\nSubject: =?UTF-8?B?5rWL6K+V?=\nDate: Tue, 23 Sep 2025 12:00:00 +0800\nMessage-ID: <example@example.org>\nMIME-Version: 1.0\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: quoted-printable\n\ncaf=E9")
	m, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if m.Subject != "测试" || m.Text != "café" {
		t.Fatalf("unexpected decoding: subject=%q text=%q", m.Subject, m.Text)
	}
	if len(m.From) != 1 || m.From[0].Address != "sender@example.org" || m.SentAt == nil || m.RFCMessageID == nil {
		t.Fatalf("missing structured headers: %+v", m)
	}
	if m.NeedsReview {
		t.Fatalf("ordinary message needs review: %+v", m.Warnings)
	}
}

func TestAlternativeAndAttachment(t *testing.T) {
	raw := wire("From: sender@example.org\nTo: owner@example.org\nSubject: Notes\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=outer\n\n--outer\nContent-Type: multipart/alternative; boundary=inner\n\n--inner\nContent-Type: text/html; charset=utf-8\n\n<p>HTML <img src=\"https://tracker.example/p\"><script>alert(1)</script></p>\n--inner\nContent-Type: text/plain; charset=utf-8\n\nPlain body\n--inner--\n--outer\nContent-Type: application/pdf\nContent-Disposition: attachment; filename=\"../../report.pdf\"\nContent-Transfer-Encoding: base64\n\nUERGIQ==\n--outer--")
	m, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if m.Text != "Plain body" {
		t.Fatalf("did not prefer plain text: %q", m.Text)
	}
	if strings.Contains(m.HTML, "script") || strings.Contains(m.HTML, "img") || strings.Contains(m.HTML, "tracker.example") {
		t.Fatalf("unsafe preview: %q", m.HTML)
	}
	if len(m.Attachments) != 1 || m.Attachments[0].PartID != "1.2" || m.Attachments[0].Filename != "report.pdf" || m.Attachments[0].Size != 4 {
		t.Fatalf("unexpected attachment: %+v", m.Attachments)
	}
	d, err := Attachment(raw, "1.2")
	if err != nil || string(d.Data) != "PDF!" || d.ContentType != "application/pdf" {
		t.Fatalf("attachment download: %+v, %v", d, err)
	}
	if _, err := Attachment(raw, "1.1.2"); !errors.Is(err, ErrNotDownload) {
		t.Fatalf("body text was downloadable: %v", err)
	}
	if _, err := Attachment(raw, "1.999"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing part: %v", err)
	}
}

func TestHTMLOnlyLinkAndActiveContent(t *testing.T) {
	raw := wire("From: sender@example.org\nTo: owner@example.org\nSubject: Link\nMIME-Version: 1.0\nContent-Type: text/html; charset=utf-8\n\n<div>Open <a href=\"https://example.org/item/7\">the item</a> <a href=\"javascript:alert(1)\">bad</a><style>body{background:url(https://tracker.example)}</style><form action=\"https://attacker.example\"><input></form></div>")
	m, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(m.Text, "https://example.org/item/7") || !strings.Contains(m.Text, "the item") {
		t.Fatalf("HTML-only link lost: %q", m.Text)
	}
	for _, bad := range []string{"javascript:", "tracker.example", "attacker.example", "<form", "<style", "<input"} {
		if strings.Contains(m.HTML, bad) || strings.Contains(m.Text, bad) {
			t.Fatalf("active content survived (%s): text=%q html=%q", bad, m.Text, m.HTML)
		}
	}
}

func TestParserLimitsAndOpaqueMail(t *testing.T) {
	if _, err := Parse(wire("Subject: long\n\n" + strings.Repeat("a", MaxTextBytes+1))); !errors.Is(err, ErrLimit) {
		t.Fatalf("text limit: %v", err)
	}
	if _, err := Parse(make([]byte, MaxRawBytes+1)); !errors.Is(err, ErrLimit) {
		t.Fatalf("raw limit: %v", err)
	}
	if _, err := Parse(wire("Subject: " + strings.Repeat("a", MaxHeaderBytes) + "\n\nsmall")); !errors.Is(err, ErrLimit) {
		t.Fatalf("huge header: %v", err)
	}
	m, err := Parse(wire("From: sender@example.org\nSubject: Nested\nMIME-Version: 1.0\nContent-Type: message/rfc822\n\nFrom: nested@example.org\nSubject: Inside\n\nNested body"))
	if err != nil {
		t.Fatal(err)
	}
	if !m.NeedsReview || len(m.Attachments) != 1 || m.Text != "" {
		t.Fatalf("attached message was promoted to body: %+v", m)
	}
}

func TestCancelledParse(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := ParseContext(ctx, wire("Subject: cancelled\n\nbody"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled parse: %v", err)
	}
}

func TestMIMETraversalLimits(t *testing.T) {
	var parts strings.Builder
	parts.WriteString("From: sender@example.org\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=many\n\n")
	for i := 0; i < MaxParts; i++ {
		parts.WriteString("--many\nContent-Type: text/plain\n\npart\n")
	}
	parts.WriteString("--many--")
	if _, err := Parse(wire(parts.String())); !errors.Is(err, ErrLimit) {
		t.Fatalf("too many MIME parts: %v", err)
	}

	body := "Content-Type: text/plain\n\nleaf"
	for i := MaxDepth; i >= 0; i-- {
		boundary := fmt.Sprintf("depth%d", i)
		body = fmt.Sprintf("Content-Type: multipart/mixed; boundary=%s\n\n--%s\n%s\n--%s--", boundary, boundary, body, boundary)
	}
	if _, err := Parse(wire(body)); !errors.Is(err, ErrLimit) {
		t.Fatalf("MIME depth: %v", err)
	}
}

func TestInlineCalendarIsDownloadable(t *testing.T) {
	raw := wire("From: sender@example.org\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=meeting\n\n--meeting\nContent-Type: text/plain\n\nMeet at noon\n--meeting\nContent-Type: text/calendar\n\nBEGIN:VCALENDAR\nEND:VCALENDAR\n--meeting--")
	m, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if m.Text != "Meet at noon" || len(m.Attachments) != 1 || m.Attachments[0].ContentType != "text/calendar" {
		t.Fatalf("calendar part lost: %+v", m)
	}
	d, err := Attachment(raw, m.Attachments[0].PartID)
	if err != nil || !strings.Contains(string(d.Data), "BEGIN:VCALENDAR") {
		t.Fatalf("calendar download: %+v %v", d, err)
	}
}

func TestSubjectOnlyMessageCanBeDelivered(t *testing.T) {
	m, err := Parse(wire("From: sender@example.org\nSubject: Reminder\n\n"))
	if err != nil {
		t.Fatal(err)
	}
	if m.Text != "" || m.Subject != "Reminder" || m.NeedsReview {
		t.Fatalf("subject-only message: %+v", m)
	}
}
