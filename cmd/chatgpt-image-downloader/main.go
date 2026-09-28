package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/autsu/chatgpt-image-downloader/internal/downloader"
	"github.com/autsu/chatgpt-image-downloader/internal/tui"
)

type counters struct{ scanned, downloaded, skipped, failed, bytes atomic.Int64 }
type logger struct {
	mu       sync.Mutex
	lastLine map[string]time.Time
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "tui" {
		if err := tui.Run(os.Args[2:]); err != nil {
			fatalf("%v", err)
		}
		return
	}
	runCLI(os.Args[1:])
}

func runCLI(args []string) {
	var curlFile, output string
	var workers, pageSize int
	var pageDelay time.Duration
	flags := flag.NewFlagSet("chatgpt-image-downloader", flag.ExitOnError)
	flags.StringVar(&curlFile, "curl-file", "", "DevTools Copy as cURL 保存的文件")
	flags.StringVar(&output, "output", "", "下载目录")
	flags.IntVar(&workers, "workers", 3, "并发下载数（1-16）")
	flags.IntVar(&pageSize, "page-size", 100, "每页图片数（1-200）")
	flags.DurationVar(&pageDelay, "page-delay", 700*time.Millisecond, "分页请求间隔")
	flags.Parse(args)
	if output == "" {
		flags.Usage()
		os.Exit(2)
	}
	if workers < 1 || workers > 16 || pageSize < 1 || pageSize > 200 {
		fatalf("workers 必须为 1-16，page-size 必须为 1-200")
	}
	cfg, err := downloader.ConfigFromCurlFile(curlFile, output)
	if err != nil {
		fatalf("读取 cURL：%v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	client := &http.Client{Timeout: 2 * time.Minute}
	control := downloader.NewController()
	stats := &counters{}
	log := &logger{lastLine: make(map[string]time.Time)}
	jobs := make(chan downloader.Item, workers*4)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				log.line("开始", item.Filename, "")
				result, err := downloader.Download(ctx, client, cfg, item, control, func(p downloader.Progress) { log.progress(item.Filename, p) })
				if err != nil {
					stats.failed.Add(1)
					log.line("失败", item.Filename, err.Error())
					continue
				}
				if result.Status == "skipped" {
					stats.skipped.Add(1)
					log.line("跳过", item.Filename, "同名文件存在且大小一致")
				} else {
					stats.downloaded.Add(1)
					stats.bytes.Add(result.Bytes)
					log.line("完成", item.Filename, formatBytes(result.Bytes))
				}
			}
		}()
	}
	err = downloader.Scan(ctx, client, cfg, pageSize, pageDelay, func(item downloader.Item) {
		count := stats.scanned.Add(1)
		if count%100 == 0 {
			log.line("扫描", fmt.Sprintf("%d 张", count), "")
		}
		select {
		case jobs <- item:
		case <-ctx.Done():
		}
	})
	close(jobs)
	wg.Wait()
	fmt.Printf("完成：扫描 %d，下载 %d，已存在 %d，失败 %d，写入 %s\n", stats.scanned.Load(), stats.downloaded.Load(), stats.skipped.Load(), stats.failed.Load(), formatBytes(stats.bytes.Load()))
	if err != nil && ctx.Err() == nil {
		fatalf("分页扫描中止：%v", err)
	}
}

func (l *logger) line(status, name, detail string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if detail != "" {
		fmt.Printf("[%s] %-4s %s — %s\n", time.Now().Format("15:04:05"), status, name, detail)
	} else {
		fmt.Printf("[%s] %-4s %s\n", time.Now().Format("15:04:05"), status, name)
	}
}

func (l *logger) progress(name string, p downloader.Progress) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.lastLine[name]) < 500*time.Millisecond && p.Received != p.Total {
		return
	}
	l.lastLine[name] = now
	percent := " -- "
	if p.Total > 0 {
		percent = fmt.Sprintf("%3.0f%%", min(100, float64(p.Received)*100/float64(p.Total)))
	}
	fmt.Printf("[%s] 进度 %-36s %s  %s/%s  %s/s\n", now.Format("15:04:05"), name, percent, formatBytes(p.Received), formatBytes(p.Total), formatBytes(int64(p.Speed)))
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
