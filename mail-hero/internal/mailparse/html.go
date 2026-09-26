package mailparse

import (
	"strings"
	"unicode"

	"github.com/microcosm-cc/bluemonday"
	"golang.org/x/net/html"
)

var previewPolicy = func() *bluemonday.Policy {
	p := bluemonday.NewPolicy()
	p.AllowElements(
		"p", "div", "span", "br", "hr", "b", "strong", "i", "em", "u", "s",
		"blockquote", "pre", "code", "ul", "ol", "li", "h1", "h2", "h3", "h4",
		"h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "a",
	)
	p.AllowAttrs("href").OnElements("a")
	p.AllowURLSchemes("http", "https", "mailto")
	p.RequireParseableURLs(true)
	p.RequireNoReferrerOnLinks(true)
	p.RequireNoFollowOnLinks(true)
	p.AddTargetBlankToFullyQualifiedLinks(true)
	p.SkipElementsContent("script", "style", "iframe", "object", "embed", "svg", "math", "head", "noscript", "form")
	return p
}()

func sanitizeHTML(input string) string {
	return previewPolicy.Sanitize(input)
}

// htmlText operates on sanitized HTML. Link destinations are included as text
// because many HTML-only mails hide the actionable URL behind a short label.
func htmlText(safeHTML string) string {
	root, err := html.Parse(strings.NewReader(safeHTML))
	if err != nil {
		return ""
	}
	var b strings.Builder
	var visit func(*html.Node)
	visit = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
			return
		}
		if n.Type == html.ElementNode && isBlock(n.Data) {
			b.WriteByte('\n')
		}
		if n.Type == html.ElementNode && n.Data == "br" {
			b.WriteByte('\n')
		}
		before := b.Len()
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
		if n.Type == html.ElementNode && n.Data == "a" {
			var href string
			for _, attr := range n.Attr {
				if attr.Key == "href" {
					href = attr.Val
					break
				}
			}
			if href != "" && !strings.Contains(b.String()[before:], href) {
				if b.Len() > before {
					b.WriteString(" (")
					b.WriteString(href)
					b.WriteByte(')')
				} else {
					b.WriteString(href)
				}
			}
		}
		if n.Type == html.ElementNode && isBlock(n.Data) {
			b.WriteByte('\n')
		}
	}
	visit(root)
	// Normalize whitespace without collapsing meaningful paragraph breaks.
	lines := strings.Split(strings.ReplaceAll(b.String(), "\u00a0", " "), "\n")
	clean := make([]string, 0, len(lines))
	blank := false
	for _, line := range lines {
		line = strings.Join(strings.FieldsFunc(line, unicode.IsSpace), " ")
		if line == "" {
			if len(clean) > 0 && !blank {
				clean = append(clean, "")
				blank = true
			}
			continue
		}
		clean = append(clean, line)
		blank = false
	}
	for len(clean) > 0 && clean[len(clean)-1] == "" {
		clean = clean[:len(clean)-1]
	}
	return strings.Join(clean, "\n")
}

func isBlock(tag string) bool {
	switch tag {
	case "p", "div", "hr", "blockquote", "pre", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr":
		return true
	default:
		return false
	}
}
