package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/autsu/chatgpt-image-downloader/internal/downloader"
)

type row struct {
	item            downloader.Item
	selected        bool
	status          string
	received, total int64
	speed           float64
	err             string
}

type scanItemMsg struct{ item downloader.Item }
type scanDoneMsg struct{ err error }
type progressMsg struct {
	name     string
	progress downloader.Progress
}
type resultMsg struct {
	name   string
	result downloader.Result
	err    error
}
type downloadsDoneMsg struct{}

type model struct {
	ctx         context.Context
	cancel      context.CancelFunc
	cfg         downloader.Config
	client      *http.Client
	events      chan tea.Msg
	control     *downloader.Controller
	rows        []row
	byName      map[string]int
	cursor      int
	offset      int
	width       int
	height      int
	workers     int
	pageSize    int
	pageDelay   time.Duration
	scanning    bool
	downloading bool
	downloadTotal int
	paused      bool
	status      string
}

var (
	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#B69CFF"))
	activeStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#FFFFFF")).Background(lipgloss.Color("#5B44C7"))
	dimStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#777777"))
	goodStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#65D46E"))
	warnStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#F2C14E"))
	badStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#FF6B6B"))
)

func main() {
	var curlFile, output string
	var workers, pageSize int
	var pageDelay time.Duration
	flag.StringVar(&curlFile, "curl-file", "", "DevTools Copy as cURL 保存的文件")
	flag.StringVar(&output, "output", "", "下载目录")
	flag.IntVar(&workers, "workers", 3, "并发下载数")
	flag.IntVar(&pageSize, "page-size", 100, "每页图片数")
	flag.DurationVar(&pageDelay, "page-delay", 700*time.Millisecond, "分页请求间隔")
	flag.Parse()
	if curlFile == "" || output == "" {
		flag.Usage()
		os.Exit(2)
	}
	cfg, err := downloader.ConfigFromCurlFile(curlFile, output)
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误：", err)
		os.Exit(1)
	}
	ctx, cancel := context.WithCancel(context.Background())
	m := model{
		ctx: ctx, cancel: cancel, cfg: cfg, client: &http.Client{Timeout: 2 * time.Minute},
		events: make(chan tea.Msg, 512), control: downloader.NewController(), byName: make(map[string]int),
		workers: workers, pageSize: pageSize, pageDelay: pageDelay, scanning: true, status: "正在扫描全部分页…",
	}
	if _, err := tea.NewProgram(m).Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func (m model) Init() tea.Cmd {
	go func() {
		err := downloader.Scan(m.ctx, m.client, m.cfg, m.pageSize, m.pageDelay, func(item downloader.Item) {
			m.events <- scanItemMsg{item: item}
		})
		m.events <- scanDoneMsg{err: err}
	}()
	return waitEvent(m.events)
}

func waitEvent(events <-chan tea.Msg) tea.Cmd {
	return func() tea.Msg { return <-events }
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case tea.KeyPressMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			m.cancel()
			return m, tea.Quit
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
		case "down", "j":
			if m.cursor+1 < len(m.rows) {
				m.cursor++
			}
		case "space":
			if !m.downloading && len(m.rows) > 0 {
				m.rows[m.cursor].selected = !m.rows[m.cursor].selected
			}
		case "a":
			if !m.downloading {
				for i := range m.rows {
					m.rows[i].selected = true
				}
			}
		case "n":
			if !m.downloading {
				for i := range m.rows {
					m.rows[i].selected = false
				}
			}
		case "d":
			if !m.scanning && !m.downloading {
				selected := make([]downloader.Item, 0)
				for i := range m.rows {
					if m.rows[i].selected {
						m.rows[i].status = "queued"
						selected = append(selected, m.rows[i].item)
					}
				}
				if len(selected) == 0 {
					m.status = "没有选中图片"
				} else {
					m.downloading = true
					m.downloadTotal = len(selected)
					m.status = fmt.Sprintf("正在下载 %d 张图片", len(selected))
					go runDownloads(m.ctx, m.client, m.cfg, m.control, selected, m.workers, m.events)
				}
			}
		case "p":
			if m.downloading {
				m.paused = !m.paused
				if m.paused {
					m.control.Pause()
					m.status = "下载已暂停"
				} else {
					m.control.Resume()
					m.status = "下载已恢复"
				}
			}
		}
	case scanItemMsg:
		if _, exists := m.byName[msg.item.Filename]; !exists {
			m.byName[msg.item.Filename] = len(m.rows)
			m.rows = append(m.rows, row{item: msg.item, selected: true, status: "ready"})
		}
		return m, waitEvent(m.events)
	case scanDoneMsg:
		m.scanning = false
		if msg.err != nil {
			m.status = "扫描失败：" + msg.err.Error()
		} else {
			m.status = fmt.Sprintf("扫描完成，共 %d 张", len(m.rows))
		}
		return m, waitEvent(m.events)
	case progressMsg:
		if index, ok := m.byName[msg.name]; ok {
			m.rows[index].status = "downloading"
			m.rows[index].received = msg.progress.Received
			m.rows[index].total = msg.progress.Total
			m.rows[index].speed = msg.progress.Speed
		}
		return m, waitEvent(m.events)
	case resultMsg:
		if index, ok := m.byName[msg.name]; ok {
			if msg.err != nil {
				m.rows[index].status, m.rows[index].err = "error", msg.err.Error()
			} else {
				m.rows[index].status = msg.result.Status
			}
			m.rows[index].speed = 0
		}
		return m, waitEvent(m.events)
	case downloadsDoneMsg:
		m.downloading, m.paused = false, false
		m.status = "下载队列处理完成"
		return m, waitEvent(m.events)
	}
	m.keepCursorVisible()
	return m, nil
}

func runDownloads(ctx context.Context, client *http.Client, cfg downloader.Config, control *downloader.Controller, items []downloader.Item, workers int, events chan<- tea.Msg) {
	jobs := make(chan downloader.Item)
	var wg sync.WaitGroup
	for range max(1, workers) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobs {
				result, err := downloader.Download(ctx, client, cfg, item, control, func(progress downloader.Progress) {
					events <- progressMsg{name: item.Filename, progress: progress}
				})
				events <- resultMsg{name: item.Filename, result: result, err: err}
			}
		}()
	}
feed:
	for _, item := range items {
		select {
		case jobs <- item:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	events <- downloadsDoneMsg{}
}

func (m *model) keepCursorVisible() {
	visible := max(1, m.height-9)
	if m.cursor < m.offset {
		m.offset = m.cursor
	}
	if m.cursor >= m.offset+visible {
		m.offset = m.cursor - visible + 1
	}
}

func (m model) View() tea.View {
	var b strings.Builder
	b.WriteString(titleStyle.Render("ChatGPT Image Downloader"))
	b.WriteString("\n")
	b.WriteString(m.summary())
	b.WriteString("\n\n")
	visible := max(1, m.height-9)
	end := min(len(m.rows), m.offset+visible)
	for i := m.offset; i < end; i++ {
		b.WriteString(m.renderRow(i))
		b.WriteByte('\n')
	}
	if len(m.rows) == 0 {
		b.WriteString(dimStyle.Render("等待接口返回图片…\n"))
	}
	b.WriteString("\n")
	b.WriteString(dimStyle.Render("↑/↓ 移动  space 选择  a 全选  n 全不选  d 下载  p 暂停/恢复  q 退出"))
	v := tea.NewView(b.String())
	v.AltScreen = true
	v.WindowTitle = "ChatGPT Image Downloader"
	return v
}

func (m model) summary() string {
	selected, complete, skipped, failed := 0, 0, 0, 0
	var speed float64
	for _, r := range m.rows {
		if r.selected {
			selected++
		}
		switch r.status {
		case "complete":
			complete++
		case "skipped":
			skipped++
		case "error":
			failed++
		}
		speed += r.speed
	}
	state := m.status
	if m.paused {
		state = warnStyle.Render(state)
	}
	processed := complete + skipped + failed
	totalBar := progressBar(int64(processed), int64(m.downloadTotal), max(16, min(42, m.width/3)))
	return fmt.Sprintf("%s\n扫描 %d  已选 %d  完成 %d  跳过 %d  失败 %d  速度 %s/s\n总进度 %s %d/%d", state, len(m.rows), selected, complete, skipped, failed, formatBytes(int64(speed)), totalBar, processed, m.downloadTotal)
}

func (m model) renderRow(index int) string {
	r := m.rows[index]
	check := "☐"
	if r.selected {
		check = "☑"
	}
	status := statusText(r)
	width := max(12, min(28, m.width/5))
	bar := progressBar(r.received, r.total, width)
	line := fmt.Sprintf("%s %-12s %s %-12s %s", check, status, bar, formatBytes(r.received), r.item.Filename)
	if r.err != "" {
		line += "  " + badStyle.Render(r.err)
	}
	if index == m.cursor {
		return activeStyle.Render(line)
	}
	return line
}

func statusText(r row) string {
	switch r.status {
	case "complete":
		return goodStyle.Render("下载完成")
	case "skipped":
		return warnStyle.Render("已存在")
	case "downloading":
		return "下载中"
	case "queued":
		return "排队中"
	case "error":
		return badStyle.Render("失败")
	default:
		return "待下载"
	}
}

func progressBar(received, total int64, width int) string {
	ratio := 0.0
	if total > 0 {
		ratio = min(1, float64(received)/float64(total))
	}
	filled := int(ratio * float64(width))
	return "[" + strings.Repeat("█", filled) + strings.Repeat("░", width-filled) + "]"
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
