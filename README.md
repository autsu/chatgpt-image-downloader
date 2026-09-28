# ChatGPT Image Downloader

中英文双语的 Manifest V3 Chrome 扩展，用于下载 ChatGPT Images 页面中的个人图片。

## 功能 · Features

- 只扫描「我的图片 / My images」区域。
- 根据真实文件类型、尺寸和体积排除 WebP 缩略图、封面图和页面公共资源。
- 自动读取全部分页，无需手动滚动到页面底部。
- 支持下载全部图片或下载选中图片。
- 下载前扫描目标目录，按稳定文件名和文件大小跳过已有文件。
- 点击下载时只枚举一次目标目录；仅对同名文件做大小校验，不在后台重复扫描磁盘。
- 支持暂停、恢复和切换下载目录。
- 显示单张图片的下载进度、已下载大小和实时速度。
- 目录由设置页通过系统文件夹选择器授权，完成后自动返回 Images 页面。
- 页面刷新、重新打开面板、切换目录或扫描到新图片时自动核对目标目录。
- 直接解析 ChatGPT `recent/image_gen` 返回的原图地址，缩略图不会进入下载列表。
- 兼容 Estuary/Blob 图片列表作为兜底。

Scans only the **My images** section on `chatgpt.com/images`, filters thumbnails by their real content type, dimensions, and size, and checks the target folder before queueing. Downloads use stable filenames and show per-file progress and speed. Pause/resume and folder switching are supported.

## 安装 · Install

1. 打开 `chrome://extensions/`。
2. 开启「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择本项目目录。
5. 打开 `https://chatgpt.com/images/` 并刷新页面。

Open `chrome://extensions/`, enable **Developer mode**, choose **Load unpacked**, select this directory, then refresh the ChatGPT Images page.

## 使用 · Usage

1. 点击页面右下角的悬浮按钮。
2. 在面板中查看扫描数量和图片列表。
3. 点击齿轮，在设置页选择下载目录。
4. 选择「下载全部图片」或「下载选中的图片」。

Click the floating button, choose a folder from the settings page, then download all images or only the checked images.

> Chrome 不会向扩展暴露 macOS 的完整绝对路径。扩展保存目录句柄并直接写入已授权目录，界面显示目录名称。
>
> Chrome does not expose the full macOS absolute path to extensions. The extension stores the directory handle and writes directly to the authorized folder.

## Go CLI

CLI 只解析 `recent/image_gen` 返回的原图 URL，不扫描网页 DOM，因此不会收集 `education-poster` 等页面素材或缩略图。

```bash
go build -o chatgpt-image-downloader ./cmd/chatgpt-image-downloader
chmod 600 /path/to/request.txt
./chatgpt-image-downloader \
  -curl-file /path/to/request.txt \
  -output /Users/you/Downloads/chatgptimg \
  -workers 3
```

在 Chrome DevTools Network 中找到 `recent/image_gen` 请求，选择 **Copy as cURL**，粘贴到 `request.txt`。该文件含登录凭据，不要提交、分享或长期保存；下载完成后删除。

The CLI reads only original URLs returned by `recent/image_gen`. Save that request with **Copy as cURL**, pass the local file with `-curl-file`, and delete it after use because it contains session credentials.

## 隐私 · Privacy

扩展只在 `chatgpt.com/images` 页面运行，不上传图片或账号数据。下载请求直接发送到图片原始地址。

Runs only on `chatgpt.com/images`. It does not upload images or account data.

## License

[MIT](LICENSE)
