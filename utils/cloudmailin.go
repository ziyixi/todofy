package utils

import (
	"regexp"
	"strings"

	"github.com/tidwall/gjson"

	md "github.com/JohannesKaufmann/html-to-markdown"
)

// MailInfo is the struct to store the parsed email information
type MailInfo struct {
	From    string // headers.from
	To      string // headers.to
	Date    string // headers.date
	Subject string // headers.subject
	Content string // md(html)
}

// ParseCloudmailin parses the cloudmailin email content
func ParseCloudmailin(s string) MailInfo {
	converter := md.NewConverter("", true, nil)
	html := gjson.Get(s, "html").String()

	// convert html to markdown
	markdownRaw, err := converter.ConvertString(html)
	if err != nil || len(markdownRaw) == 0 {
		// use plain text instead
		markdownRaw = gjson.Get(s, "plain").String()
	}

	// remove all urls, otherwise there will be too many tokens for next-step processing
	urlPattern := `\(\s*https[^()]*\)`
	m := regexp.MustCompile(urlPattern)
	markdown := m.ReplaceAllString(markdownRaw, "()")

	res := MailInfo{
		From:    gjson.Get(s, "headers.from").String(),
		To:      gjson.Get(s, "headers.to").String(),
		Date:    gjson.Get(s, "headers.date").String(),
		Subject: gjson.Get(s, "headers.subject").String(),
		Content: markdown,
	}

	// Outlook email subject may have a prefix FW:
	heloDomain := gjson.Get(s, "envelope.helo_domain").String()
	if strings.Contains(heloDomain, "outlook") && strings.HasPrefix(res.Subject, "FW: ") {
		res.Subject = res.Subject[4:]
	}

	// Outlook might foward the email in the forwarding format
	if strings.Contains(res.To, "cloudmailin") {
		// parse the correct email address
		re, _ := regexp.Compile(`_+\\r\\nFrom: .*?([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)`)
		matches := re.FindStringSubmatch(s)
		if len(matches) < 2 {
			res.To = res.From
			res.From = "sender unknown"
		} else {
			res.To = res.From
			res.From = matches[1]
		}
	}

	return res
}
