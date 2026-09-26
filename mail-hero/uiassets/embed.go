// Package uiassets embeds the compiled, self-hosted administration UI.
// Build order: npm --prefix web ci && npm --prefix web run build, then go build.
package uiassets

import (
	"bytes"
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed dist/*
var files embed.FS

func Handler() (http.Handler, error) {
	root, err := fs.Sub(files, "dist")
	if err != nil {
		return nil, err
	}
	fileServer := http.FileServer(http.FS(root))
	index, err := fs.ReadFile(root, "index.html")
	if err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
		clean := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if clean == "" || clean == "index.html" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(index))
			return
		}
		if clean != "" {
			if f, e := root.Open(clean); e == nil {
				stat, _ := f.Stat()
				f.Close()
				if stat != nil && !stat.IsDir() {
					fileServer.ServeHTTP(w, r)
					return
				}
			}
			if strings.Contains(path.Base(clean), ".") {
				http.NotFound(w, r)
				return
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(index))
	}), nil
}
