package downloader

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Config struct {
	URL     string
	Headers http.Header
	Output  string
}

type Item struct {
	ID       string
	URL      string
	Filename string
}

type Progress struct {
	Received int64
	Total    int64
	Speed    float64
}

type Result struct {
	Status string
	Bytes  int64
	Path   string
}

type apiItem struct {
	ID            string `json:"id"`
	URL           string `json:"url"`
	OutputBlocked bool   `json:"output_blocked"`
	Archived      bool   `json:"is_archived"`
}

type pageResponse struct {
	Items  []apiItem `json:"items"`
	Cursor string    `json:"cursor"`
}

type Controller struct {
	mu     sync.Mutex
	paused bool
	wake   chan struct{}
}

func NewController() *Controller { return &Controller{wake: make(chan struct{})} }

func (c *Controller) Pause() {
	c.mu.Lock()
	c.paused = true
	c.mu.Unlock()
}

func (c *Controller) Resume() {
	c.mu.Lock()
	if c.paused {
		c.paused = false
		close(c.wake)
		c.wake = make(chan struct{})
	}
	c.mu.Unlock()
}

func (c *Controller) Paused() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.paused
}

func (c *Controller) Wait(ctx context.Context) error {
	for {
		c.mu.Lock()
		paused, wake := c.paused, c.wake
		c.mu.Unlock()
		if !paused {
			return nil
		}
		select {
		case <-wake:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

var (
	quotedValue = regexp.MustCompile(`(?s)^['"](.*)['"]$`)
	fileID      = regexp.MustCompile(`(?i)file_[a-z0-9]+`)
	unsafeName  = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)
)

func ConfigFromCurlFile(path, output string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	text := strings.ReplaceAll(string(raw), "\\\n", " ")
	endpoint := optionValue(text, "--url")
	u, err := url.Parse(endpoint)
	if err != nil || u.Host != "chatgpt.com" || u.Path != "/backend-api/my/recent/image_gen" {
		return Config{}, errors.New("cURL 不是 chatgpt.com 的 recent/image_gen 请求")
	}
	headers := make(http.Header)
	pattern := regexp.MustCompile(`(?s)-H\s+('[^']*'|"[^"]*")`)
	for _, match := range pattern.FindAllString(text, -1) {
		value := unquote(strings.TrimSpace(strings.TrimPrefix(match, "-H")))
		name, value, ok := strings.Cut(value, ":")
		if !ok {
			continue
		}
		name = http.CanonicalHeaderKey(strings.TrimSpace(name))
		if name != "Host" && name != "Content-Length" {
			headers.Set(name, strings.TrimSpace(value))
		}
	}
	if cookie := optionValue(text, "-b"); cookie != "" {
		headers.Set("Cookie", cookie)
	}
	if headers.Get("Authorization") == "" || headers.Get("Chatgpt-Account-Id") == "" {
		return Config{}, errors.New("缺少 Authorization 或 chatgpt-account-id")
	}
	query := u.Query()
	query.Del("after")
	u.RawQuery = query.Encode()
	if err := os.MkdirAll(output, 0o755); err != nil {
		return Config{}, err
	}
	return Config{URL: u.String(), Headers: headers, Output: output}, nil
}

func Scan(ctx context.Context, client *http.Client, cfg Config, pageSize int, delay time.Duration, onItem func(Item)) error {
	next := cfg.URL
	seenCursors := make(map[string]struct{})
	seenItems := make(map[string]struct{})
	for next != "" {
		page, err := fetchPage(ctx, client, next, cfg.Headers, pageSize)
		if err != nil {
			return err
		}
		for _, raw := range page.Items {
			if raw.URL == "" || raw.OutputBlocked || raw.Archived || !IsOriginalURL(raw.URL) {
				continue
			}
			item := Item{ID: raw.ID, URL: raw.URL, Filename: StableBase(raw.ID, raw.URL)}
			if _, exists := seenItems[item.Filename]; exists {
				continue
			}
			seenItems[item.Filename] = struct{}{}
			onItem(item)
		}
		if page.Cursor == "" {
			return nil
		}
		if _, exists := seenCursors[page.Cursor]; exists {
			return errors.New("服务端返回了重复 cursor")
		}
		seenCursors[page.Cursor] = struct{}{}
		u, _ := url.Parse(cfg.URL)
		query := u.Query()
		query.Set("after", page.Cursor)
		u.RawQuery = query.Encode()
		next = u.String()
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func Download(ctx context.Context, client *http.Client, cfg Config, item Item, control *Controller, onProgress func(Progress)) (Result, error) {
	if existing, ok := FindExisting(cfg.Output, item.Filename); ok {
		matches, err := sameRemoteSize(ctx, client, cfg.Headers, item.URL, existing)
		if err == nil && matches {
			return Result{Status: "skipped", Path: existing}, nil
		}
	}
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		if err := control.Wait(ctx); err != nil {
			return Result{}, err
		}
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(1<<attempt) * time.Second):
			case <-ctx.Done():
				return Result{}, ctx.Err()
			}
		}
		result, err := fetchToFile(ctx, client, cfg, item, control, onProgress)
		if err == nil {
			return result, nil
		}
		lastErr = err
	}
	return Result{Status: "error"}, lastErr
}

func fetchPage(ctx context.Context, client *http.Client, endpoint string, headers http.Header, pageSize int) (pageResponse, error) {
	u, _ := url.Parse(endpoint)
	query := u.Query()
	query.Set("limit", strconv.Itoa(pageSize))
	u.RawQuery = query.Encode()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	copyHeaders(req.Header, headers)
	resp, err := client.Do(req)
	if err != nil {
		return pageResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return pageResponse{}, fmt.Errorf("列表接口 HTTP %d", resp.StatusCode)
	}
	var page pageResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&page); err != nil {
		return pageResponse{}, err
	}
	return page, nil
}

func fetchToFile(ctx context.Context, client *http.Client, cfg Config, item Item, control *Controller, onProgress func(Progress)) (Result, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, item.URL, nil)
	copyHeaders(req.Header, cfg.Headers)
	resp, err := client.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	finalPath := filepath.Join(cfg.Output, item.Filename+extension(resp.Header.Get("Content-Type")))
	tempPath := finalPath + ".part"
	file, err := os.OpenFile(tempPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return Result{}, err
	}
	buffer := make([]byte, 128*1024)
	var received, sampleBytes int64
	sampleAt := time.Now()
	var speed float64
	for {
		if err := control.Wait(ctx); err != nil {
			file.Close()
			return Result{}, err
		}
		n, readErr := resp.Body.Read(buffer)
		if n > 0 {
			written, writeErr := file.Write(buffer[:n])
			received += int64(written)
			if writeErr != nil || written != n {
				file.Close()
				_ = os.Remove(tempPath)
				return Result{}, errors.Join(writeErr, io.ErrShortWrite)
			}
			now := time.Now()
			if now.Sub(sampleAt) >= 150*time.Millisecond || (resp.ContentLength > 0 && received == resp.ContentLength) {
				instant := float64(received-sampleBytes) / now.Sub(sampleAt).Seconds()
				if speed == 0 {
					speed = instant
				} else {
					speed = speed*0.65 + instant*0.35
				}
				onProgress(Progress{Received: received, Total: resp.ContentLength, Speed: speed})
				sampleAt, sampleBytes = now, received
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			file.Close()
			_ = os.Remove(tempPath)
			return Result{}, readErr
		}
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tempPath)
		return Result{}, err
	}
	if resp.ContentLength >= 0 && received != resp.ContentLength {
		_ = os.Remove(tempPath)
		return Result{}, fmt.Errorf("文件不完整：%d/%d", received, resp.ContentLength)
	}
	if err := os.Rename(tempPath, finalPath); err != nil {
		_ = os.Remove(tempPath)
		return Result{}, err
	}
	onProgress(Progress{Received: received, Total: received, Speed: speed})
	return Result{Status: "complete", Bytes: received, Path: finalPath}, nil
}

func sameRemoteSize(ctx context.Context, client *http.Client, headers http.Header, source, existing string) (bool, error) {
	info, err := os.Stat(existing)
	if err != nil {
		return false, err
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodHead, source, nil)
	copyHeaders(req.Header, headers)
	resp, err := client.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || resp.ContentLength < 0 {
		return true, nil
	}
	return info.Size() == resp.ContentLength, nil
}

func FindExisting(output, base string) (string, bool) {
	for _, ext := range []string{".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"} {
		path := filepath.Join(output, base+ext)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path, true
		}
	}
	return "", false
}

func StableBase(id, rawURL string) string {
	if match := fileID.FindString(rawURL); match != "" {
		return "ChatGPT-" + strings.ToLower(match)
	}
	id = strings.Trim(unsafeName.ReplaceAllString(id, "-"), "-")
	if id == "" {
		id = "unknown"
	}
	return "ChatGPT-" + id
}

func IsOriginalURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host != "chatgpt.com" || u.Path != "/backend-api/estuary/content" {
		return false
	}
	id, _ := url.QueryUnescape(u.Query().Get("id"))
	return fileID.MatchString(id) && !strings.Contains(strings.ToLower(id), "thumbnail")
}

func extension(contentType string) string {
	switch strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0])) {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "image/avif":
		return ".avif"
	default:
		return ".png"
	}
}

func copyHeaders(dst, src http.Header) {
	for name, values := range src {
		for _, value := range values {
			dst.Add(name, value)
		}
	}
}

func optionValue(text, option string) string {
	pattern := regexp.MustCompile(`(?s)` + regexp.QuoteMeta(option) + `\s+('[^']*'|"[^"]*"|\S+)`)
	match := pattern.FindStringSubmatch(text)
	if len(match) != 2 {
		return ""
	}
	return unquote(match[1])
}

func unquote(value string) string {
	match := quotedValue.FindStringSubmatch(strings.TrimSpace(value))
	if len(match) == 2 {
		return strings.ReplaceAll(match[1], `\"`, `"`)
	}
	return value
}
