#!/usr/bin/env node

const fs = require("fs/promises");
const fss = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

const DEFAULT_USER_AGENT = "PostmanRuntime/7.29.0";
const DEFAULT_DELAY_MS = 1200;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 10;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);
const ATTACHMENT_BLOCK_PATTERN = /^(.+?)\r?\n\[data:image\/[a-zA-Z0-9.+-]+;base64,[^\]]+\]\r?\n\1\r?\n\[(https?:\/\/[^\]]+)\]/gm;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const rootDir = path.resolve(options.rootDir || process.cwd());
  const requestHeaders = createRequestHeaders(options.userAgent, options.cookie);
  const delayMs = normalizeDelayMs(options.delayMs);

  const stat = await fs.stat(rootDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    console.error(`Directory not found: ${rootDir}`);
    process.exitCode = 1;
    return;
  }

  const txtFiles = await findTxtFiles(rootDir);
  if (txtFiles.length === 0) {
    console.log("No .txt files found.");
    return;
  }

  let matchesFound = 0;
  let downloaded = 0;
  let failed = 0;

  for (const txtFile of txtFiles) {
    const content = await fs.readFile(txtFile, "utf8").catch(() => "");
    if (!content) {
      continue;
    }

    const blocks = extractBlocks(content);
    if (blocks.length === 0) {
      continue;
    }

    matchesFound += blocks.length;
    const attachmentsDir = path.join(path.dirname(txtFile), "attachments");
    await fs.mkdir(attachmentsDir, { recursive: true });

    for (const block of blocks) {
      const baseName = chooseOutputFileName(block.fileName, block.url);
      const outputPath = await uniqueOutputPath(attachmentsDir, baseName);

      try {
        await downloadFile(block.url, outputPath, requestHeaders);
        downloaded += 1;
        console.log(`Downloaded: ${block.url} -> ${outputPath}`);
      } catch (error) {
        failed += 1;
        console.error(`Failed: ${block.url}`);
        console.error(`  ${error.message}`);
      } finally {
        await sleep(delayMs);
      }
    }
  }

  console.log("\nDone.");
  console.log(`TXT files scanned: ${txtFiles.length}`);
  console.log(`Pattern matches found: ${matchesFound}`);
  console.log(`Downloaded: ${downloaded}`);
  console.log(`Failed: ${failed}`);
}

function extractBlocks(text) {
  const results = [];

  let match;
  ATTACHMENT_BLOCK_PATTERN.lastIndex = 0;
  while ((match = ATTACHMENT_BLOCK_PATTERN.exec(text)) !== null) {
    results.push({
      fileName: match[1].trim(),
      url: match[2].trim(),
    });
  }

  return results;
}

async function findTxtFiles(rootDir) {
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function fileNameFromUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const fromQuery = fileNameFromMediaQuery(parsed);
    if (fromQuery) {
      return fromQuery;
    }

    const base = decodePathBaseName(parsed.pathname);
    if (base && !isGenericPhpName(base)) {
      return safeFileName(base);
    }

    return "";
  } catch {
    return "";
  }
}

function chooseOutputFileName(blockFileName, urlString) {
  const cleanedBlockName = safeFileName((blockFileName || "").trim());
  const blockNameLooksValid = cleanedBlockName && !isGenericPhpName(cleanedBlockName);

  if (blockNameLooksValid) {
    return cleanedBlockName;
  }

  const fromUrl = fileNameFromUrl(urlString);
  if (fromUrl) {
    return fromUrl;
  }

  return "download.bin";
}

function fileNameFromMediaQuery(parsedUrl) {
  const mediaKeys = ["media", "attachment", "file", "filename", "download"];

  for (const key of mediaKeys) {
    const value = parsedUrl.searchParams.get(key);
    if (!value) {
      continue;
    }

    const baseName = decodePathBaseName(value);
    if (baseName) {
      return safeFileName(baseName);
    }
  }

  return "";
}

function decodePathBaseName(value) {
  const decoded = tryDecodeURIComponent(value);
  const normalized = decoded.replace(/\\/g, "/");
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (looksLikeFileName(segment)) {
      return segment;
    }
  }

  const base = path.posix.basename(normalized).trim();
  return base;
}

function tryDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isGenericPhpName(name) {
  return /^index\.php$/i.test(name);
}

function looksLikeFileName(value) {
  return /\.[A-Za-z0-9]{2,8}(?:$|[?#])/u.test(value);
}

function safeFileName(input) {
  return input.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
}

function parseArgs(args) {
  let rootDir = "";
  let cookie = process.env.ATTACHMENT_COOKIE || "";
  let userAgent = process.env.ATTACHMENT_USER_AGENT || DEFAULT_USER_AGENT;
  let delayMs = process.env.ATTACHMENT_DELAY_MS || String(DEFAULT_DELAY_MS);
  let help = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }

    if (arg === "-k" || arg === "--cookie") {
      cookie = args[i + 1] || "";
      i += 1;
      continue;
    }

    if (arg === "-u" || arg === "--user-agent") {
      userAgent = args[i + 1] || DEFAULT_USER_AGENT;
      i += 1;
      continue;
    }

    if (arg === "-d" || arg === "--delay-ms") {
      delayMs = args[i + 1] || String(DEFAULT_DELAY_MS);
      i += 1;
      continue;
    }

    if (!arg.startsWith("-") && !rootDir) {
      rootDir = arg;
    }
  }

  return { rootDir, cookie, userAgent, delayMs, help };
}

function normalizeDelayMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_DELAY_MS;
  }
  return Math.floor(parsed);
}

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createRequestHeaders(userAgent, cookie) {
  const headers = {
    "User-Agent": userAgent || DEFAULT_USER_AGENT,
    Accept: "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
  };

  if (cookie) {
    headers.Cookie = cookie;
  }

  return headers;
}

function printHelp() {
  console.log("Usage:");
  console.log("  node download-attachments.js [directory] [-k cookie] [-u user-agent] [-d delay-ms]");
  console.log("");
  console.log("Examples:");
  console.log("  node download-attachments.js . -k \"xf_session=...;xf_csrf=...\"");
  console.log("  node download-attachments.js . -k \"xf_session=...\" -d 1500");
  console.log("  ATTACHMENT_COOKIE=\"xf_session=...\" ATTACHMENT_DELAY_MS=1500 npm run download:attachments -- .");
}

async function uniqueOutputPath(dir, baseName) {
  const parsed = path.parse(baseName);
  let candidate = path.join(dir, parsed.base || "download.bin");
  let counter = 1;

  while (await pathExists(candidate)) {
    candidate = path.join(dir, `${parsed.name || "download"}-${counter}${parsed.ext}`);
    counter += 1;
  }

  return candidate;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function downloadFile(urlString, destinationPath, requestHeaders, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      reject(new Error("Too many redirects"));
      return;
    }

    const client = urlString.startsWith("https:") ? https : http;
    const request = client.get(urlString, { headers: requestHeaders }, (response) => {
      const status = response.statusCode || 0;

      if (status >= 300 && status < 400 && response.headers.location) {
        const redirectedUrl = new URL(response.headers.location, urlString).toString();
        response.resume();
        downloadFile(redirectedUrl, destinationPath, requestHeaders, redirectCount + 1)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      const fileStream = fss.createWriteStream(destinationPath);
      response.pipe(fileStream);

      fileStream.on("finish", () => {
        fileStream.close();
        resolve();
      });

      fileStream.on("error", (error) => {
        fileStream.destroy();
        fs.unlink(destinationPath).catch(() => null).finally(() => {
          reject(error);
        });
      });

      response.on("error", (error) => {
        fileStream.destroy(error);
      });
    });

    request.on("error", reject);
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Request timeout"));
    });
  });
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});
