const { app, BrowserWindow, Menu, shell } = require("electron");
const { createReadStream, promises: fs } = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pathToFileURL } = require("node:url");

const HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

let localServer;

function applicationRoot() {
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "..");
}

function safeAssetPath(clientRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const resolved = path.resolve(clientRoot, relative);
  return resolved === clientRoot || resolved.startsWith(`${clientRoot}${path.sep}`) ? resolved : null;
}

async function assetResponse(clientRoot, request) {
  const url = new URL(request.url);
  const assetPath = safeAssetPath(clientRoot, url.pathname);
  if (!assetPath) return new Response("Not found", { status: 404 });
  try {
    const info = await fs.stat(assetPath);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
    const headers = new Headers({
      "content-length": String(info.size),
      "content-type": mimeTypes.get(path.extname(assetPath).toLowerCase()) || "application/octet-stream",
    });
    if (url.pathname.startsWith("/_next/static/")) headers.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(Readable.toWeb(createReadStream(assetPath)), { status: 200, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function requestBody(incoming) {
  if (["GET", "HEAD"].includes(incoming.method || "GET")) return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function sendFetchResponse(outgoing, response, headOnly = false) {
  outgoing.statusCode = response.status;
  outgoing.statusMessage = response.statusText;
  const setCookies = response.headers.getSetCookie?.() || [];
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") outgoing.setHeader(name, value);
  }
  if (setCookies.length) outgoing.setHeader("set-cookie", setCookies);
  if (headOnly || !response.body) {
    outgoing.end();
    return;
  }
  Readable.fromWeb(response.body).pipe(outgoing);
}

async function startLocalServer() {
  const root = applicationRoot();
  const clientRoot = path.join(root, "dist", "client");
  const workerEntry = path.join(root, "dist", "server", "index.js");
  const { default: worker } = await import(pathToFileURL(workerEntry).href);

  localServer = http.createServer(async (incoming, outgoing) => {
    try {
      const origin = `http://${HOST}:${localServer.address().port}`;
      const url = new URL(incoming.url || "/", origin);
      const directAsset = await assetResponse(clientRoot, new Request(url));
      if (directAsset.ok) {
        await sendFetchResponse(outgoing, directAsset, incoming.method === "HEAD");
        return;
      }
      const body = await requestBody(incoming);
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        body,
      });
      const response = await worker.fetch(request, {
        ASSETS: { fetch: (assetRequest) => assetResponse(clientRoot, assetRequest) },
      }, {
        waitUntil() {},
        passThroughOnException() {},
      });
      await sendFetchResponse(outgoing, response, incoming.method === "HEAD");
    } catch (error) {
      if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") {
        outgoing.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
        outgoing.end("請求內容過大");
        return;
      }
      console.error("Local server error", error);
      outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end("史料研析台暫時無法回應");
    }
  });

  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, HOST, resolve);
  });
  return `http://${HOST}:${localServer.address().port}`;
}

function createWindow(origin) {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#f4f0e8",
    title: "史料研析台",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(origin)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(origin)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  void window.loadURL(origin);
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  try {
    const origin = await startLocalServer();
    if (process.env.SHILIAO_DESKTOP_SMOKE_TEST === "1") {
      const response = await fetch(origin);
      const html = await response.text();
      if (!response.ok || !html.includes("史料研析台")) throw new Error("Desktop smoke test failed");
      console.log(`DESKTOP_SMOKE_TEST_OK ${response.status}`);
      app.quit();
      return;
    }
    createWindow(origin);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(origin);
    });
  } catch (error) {
    console.error("Unable to start desktop application", error);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  localServer?.close();
});
