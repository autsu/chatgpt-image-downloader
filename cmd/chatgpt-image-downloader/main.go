package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type imageItem struct {
	ID            string `json:"id"`
	URL           string `json:"url"`
	OutputBlocked bool   `json:"output_blocked"`
	Archived      bool   `json:"is_archived"`
}

type pageResponse struct {
	Items  []imageItem `json:"items"`
	Cursor string      `json:"cursor"`
}

type curlConfig struct {
	URL     string
	Headers http.Header
}

type counters struct {
	scanned, downloaded, skipped, failed, bytes atomic.Int64
}

var (
	quotedValue = regexp.MustCompile(`(?s)^['"](.*)['"]$`)
	fileID      = regexp.MustCompile(`(?i)file_[a-z0-9]+`)
	unsafeName  = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)
)

func main() {
	var curlFile, output string
	var workers, pageSize int
	var pageDelay time.Duration
	flag.StringVar(&curlFile, "curl-file", "", "DevTools Copy as cURL 保存的文件")
	flag.StringVar(&output, "output", "", "下载目录")
	flag.IntVar(&workers, "workers", 3, "并发下载数（1-16）")
	flag.IntVar(&pageSize, "page-size", 100, "每页图片数（1-200）")
	flag.DurationVar(&pageDelay, "page-delay", 700*time.Millisecond, "分页请求间隔")
	flag.Parse()
	if curlFile == "" || output == "" {
		flag.Usage()
		os.Exit(2)
	}
	if workers < 1 || workers > 16 || pageSize < 1 || pageSize > 200 {
		fatalf("workers 必须为 1-16，page-size 必须为 1-200")
	}
	if err := os.MkdirAll(output, 0o755); err != nil {
		fatalf("创建下载目录：%v", err)
	}
	cfg, err := parseCurlFile(curlFile)
	if err != nil {
		fatalf("读取 cURL：%v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	client := &http.Client{Timeout: 2 * time.Minute}
	stats := &counters{}
	jobs := make(chan imageItem, workers*4)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			consume(ctx, client, cfg.Headers, output, jobs, stats)
		}()
	}
	progressDone := make(chan struct{})
	go func() { progress(ctx, stats); close(progressDone) }()

	err = produce(ctx, client, cfg, pageSize, pageDelay, jobs, stats)
	close(jobs)
	wg.Wait()
	stop()
	<-progressDone
	fmt.Printf("\n完成：扫描 %d，下载 %d，已存在 %d，失败 %d，写入 %s\n",
		stats.scanned.Load(), stats.downloaded.Load(), stats.skipped.Load(), stats.failed.Load(), formatBytes(stats.bytes.Load()))
	if err != nil && !errors.Is(err, context.Canceled) {
		fatalf("分页扫描中止：%v", err)
	}
}

func parseCurlFile(path string) (curlConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return curlConfig{}, err
	}
	text := strings.ReplaceAll(string(raw), "\\\n", " ")
	endpoint := optionValue(text, "--url")
	u, err := url.Parse(endpoint)
	if err != nil || u.Host != "chatgpt.com" || u.Path != "/backend-api/my/recent/image_gen" {
		return curlConfig{}, errors.New("cURL 不是 chatgpt.com 的 recent/image_gen 请求")
	}
	headers := make(http.Header)
	headerPattern := regexp.MustCompile(`(?s)-H\s+('[^']*'|"[^"]*")`)
	for _, match := range headerPattern.FindAllString(text, -1) {
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
		return curlConfig{}, errors.New("缺少 Authorization 或 chatgpt-account-id")
	}
	query := u.Query()
	query.Del("after")
	u.RawQuery = query.Encode()
	return curlConfig{URL: u.String(), Headers: headers}, nil
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

func produce(ctx context.Context, client *http.Client, cfg curlConfig, pageSize int, delay time.Duration, jobs chan<- imageItem, stats *counters) error {
	next := cfg.URL
	seenCursors := make(map[string]struct{})
	for next != "" {
		page, err := fetchPage(ctx, client, next, cfg.Headers, pageSize)
		if err != nil {
			return err
		}
		for _, item := range page.Items {
			if item.URL == "" || item.OutputBlocked || item.Archived || !isOriginalURL(item.URL) {
				continue
			}
			stats.scanned.Add(1)
			select {
			case jobs <- item:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		if page.Cursor == "" {
			break
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

func consume(ctx context.Context, client *http.Client, headers http.Header, output string, jobs <-chan imageItem, stats *counters) {
	for item := range jobs {
		if err := downloadOne(ctx, client, headers, output, item, stats); err != nil {
			stats.failed.Add(1)
			fmt.Fprintf(os.Stderr, "\n失败 %s: %v\n", stableBase(item), err)
		}
	}
}

func downloadOne(ctx context.Context, client *http.Client, headers http.Header, output string, item imageItem, stats *counters) error {
	base := stableBase(item)
	if existing, ok := findExisting(output, base); ok {
		matches, err := sameRemoteSize(ctx, client, headers, item.URL, existing)
		if err == nil && matches {
			stats.skipped.Add(1)
			return nil
		}
	}
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			select {
			case <-time.After(time.Duration(1<<attempt) * time.Second):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		written, err := fetchToFile(ctx, client, headers, output, base, item.URL)
		if err == nil {
			stats.downloaded.Add(1)
			stats.bytes.Add(written)
			return nil
		}
		lastErr = err
	}
	return lastErr
}

func fetchToFile(ctx context.Context, client *http.Client, headers http.Header, output, base, source string) (int64, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	copyHeaders(req.Header, headers)
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	finalPath := filepath.Join(output, base+extension(resp.Header.Get("Content-Type")))
	tempPath := finalPath + ".part"
	file, err := os.OpenFile(tempPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(file, resp.Body)
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tempPath)
		return written, errors.Join(copyErr, closeErr)
	}
	if resp.ContentLength >= 0 && written != resp.ContentLength {
		_ = os.Remove(tempPath)
		return written, fmt.Errorf("文件不完整：%d/%d", written, resp.ContentLength)
	}
	if info, err := os.Stat(finalPath); err == nil && info.Size() == written {
		_ = os.Remove(tempPath)
		return 0, nil
	}
	if err := os.Rename(tempPath, finalPath); err != nil {
		_ = os.Remove(tempPath)
		return written, err
	}
	return written, nil
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

func findExisting(output, base string) (string, bool) {
	for _, ext := range []string{".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"} {
		path := filepath.Join(output, base+ext)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path, true
		}
	}
	return "", false
}

func stableBase(item imageItem) string {
	if id := fileID.FindString(item.URL); id != "" {
		return "ChatGPT-" + strings.ToLower(id)
	}
	id := strings.Trim(unsafeName.ReplaceAllString(item.ID, "-"), "-")
	if id == "" {
		id = "unknown"
	}
	return "ChatGPT-" + id
}

func isOriginalURL(raw string) bool {
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

func progress(ctx context.Context, stats *counters) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			fmt.Printf("\r扫描 %d  下载 %d  已存在 %d  失败 %d  %s    ", stats.scanned.Load(), stats.downloaded.Load(), stats.skipped.Load(), stats.failed.Load(), formatBytes(stats.bytes.Load()))
		case <-ctx.Done():
			return
		}
	}
}

func formatBytes(value int64) string {
	if value < 1024 {
		return fmt.Sprintf("%d B", value)
	}
	if value < 1024*1024 {
		return fmt.Sprintf("%.1f KB", float64(value)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(value)/(1024*1024))
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "错误："+format+"\n", args...)
	os.Exit(1)
}
