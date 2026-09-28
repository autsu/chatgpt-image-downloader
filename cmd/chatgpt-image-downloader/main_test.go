package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseCurlAndRemoveCursor(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request.txt")
	data := `curl --url 'https://chatgpt.com/backend-api/my/recent/image_gen?limit=20&after=old' \
  -H 'authorization: Bearer test-token' \
  -H 'chatgpt-account-id: account-1' \
  -b 'session=test-cookie'`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := parseCurlFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.URL != "https://chatgpt.com/backend-api/my/recent/image_gen?limit=20" {
		t.Fatalf("unexpected URL: %s", cfg.URL)
	}
	if cfg.Headers.Get("Authorization") != "Bearer test-token" || cfg.Headers.Get("Cookie") != "session=test-cookie" {
		t.Fatal("headers were not parsed")
	}
}

func TestOnlyAcceptOriginalEstuaryURL(t *testing.T) {
	original := "https://chatgpt.com/backend-api/estuary/content?id=file_abc123&sig=x"
	thumbnail := "https://chatgpt.com/backend-api/estuary/content?id=prefix%23file_abc123%23thumbnail&sig=x"
	asset := "https://chatgpt.com/cdn/assets/education-poster.png"
	if !isOriginalURL(original) {
		t.Fatal("original URL rejected")
	}
	if isOriginalURL(thumbnail) || isOriginalURL(asset) {
		t.Fatal("thumbnail or page asset accepted")
	}
	if got := stableBase(imageItem{URL: original}); got != "ChatGPT-file_abc123" {
		t.Fatalf("unexpected stable name: %s", got)
	}
}
