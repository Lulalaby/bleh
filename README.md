# XenForo Attachment Downloader

Small Node.js CLI tool that recursively scans `.txt` files, extracts XenForo attachment URLs from matching blocks, and downloads images into an `attachments/` folder next to each source text file.

## Used with xenforo-dl

This tool is intended to be used together with [`xenforo-dl`](https://github.com/patrickkfkan/xenforo-dl), which generates the forum export/text data this downloader processes.

## Requirements

- Node.js 18+

## Usage

From the project root:

```bash
node download-attachments.js [directory] [-k cookie] [-u user-agent] [-d delay-ms]
```

### Examples

```bash
node download-attachments.js .
node download-attachments.js . -k "xf_session=...;xf_csrf=...;xf_user=..."
node download-attachments.js . -k "xf_session=..." -d 1500
```

You can also use environment variables:

- `ATTACHMENT_COOKIE`
- `ATTACHMENT_USER_AGENT`
- `ATTACHMENT_DELAY_MS`

## What it does

- Recursively finds `.txt` files.
- Matches blocks in this pattern:
  1. file name line
  2. `[data:image/...;base64,...]`
  3. same file name line
  4. `[https://...attachment-url...]`
- Downloads each match to `attachments/`.
- Adds wait time between requests to reduce rate-limit risk.
- Avoids overwrite by generating unique output names.
