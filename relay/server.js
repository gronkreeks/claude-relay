// Claude Relay: sits between the Chrome extension and the Anthropic API.
//
//   extension  --(relay token)-->  this server  --(API key)-->  api.anthropic.com
//   extension  <--(SSE stream)---  this server  <--(stream)---  api.anthropic.com
//
// The Anthropic API key lives only here (an environment variable). The extension only knows
// the relay URL and a shared relay token, so a leaked extension never leaks the API key.

import http from "node:http";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

// ---------- config ----------
const PORT = Number(process.env.PORT || 8787);
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean); // empty = any chrome-extension:// origin
const MAX_BODY_BYTES = 30 * 1024 * 1024; // the API caps a request at 32 MB
const MAX_TOOL_TURNS = 10; // create_file calls per user message
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 20);

// Only these models can be asked for, so a stolen relay token can't pick anything else.
const MODELS = {
  "claude-fable-5-2": { fallbacks: true },
  "claude-opus-5-5": { fallbacks: true },
  "claude-sonnet-5-5": { fallbacks: true },
  "claude-haiku-5-5": { fallbacks: false }, // no server-side fallback for Haiku
};
const DEFAULT_MODEL = MODELS[process.env.DEFAULT_MODEL] ? process.env.DEFAULT_MODEL : "claude-opus-5-5";
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to the environment (on Render: Environment tab).");
  process.exit(1);
}
if (RELAY_TOKEN.length < 16) {
  console.error("RELAY_TOKEN is missing or shorter than 16 characters. Set a long random value.");
  process.exit(1);
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL if set)

const SYSTEM_PROMPT = `You are Claude, talking with the user through a Chrome extension side panel.
The user can attach files (images, PDFs, text and code files) and the text of the web page they are on.

When the user asks you to make, write, export or save a file, call the create_file tool once per file with the
complete contents. The file is delivered to the user as a download, so don't also paste its full contents into
your reply; say in a sentence what you made. Use encoding "utf8" for any text format (txt, md, csv, json, html,
svg, code, etc.). Only use "base64" for small binary files you can encode exactly.`;

const CREATE_FILE_TOOL = {
  name: "create_file",
  description:
    "Create a file and deliver it to the user as a download in the extension. Use for any file the user asks " +
    "you to make. Give the full contents; the user cannot see partial files.",
  eager_input_streaming: true, // large file bodies stream as they're generated instead of in one burst
  input_schema: {
    type: "object",
    properties: {
      filename: { type: "string", description: "File name with extension, e.g. report.md or data.csv" },
      content: { type: "string", description: "The complete file contents" },
      encoding: { type: "string", enum: ["utf8", "base64"], description: "How content is encoded. Default utf8." },
      mime_type: { type: "string", description: "Optional MIME type, e.g. text/csv" },
    },
    required: ["filename", "content"],
    additionalProperties: false,
  },
};

// ---------- helpers ----------
function tokenOk(header) {
  const given = (header || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(RELAY_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function originAllowed(origin) {
  if (!origin) return true; // curl, server-to-server
  if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
  return origin.startsWith("chrome-extension://");
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
  }
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const hits = new Map(); // ip -> timestamps within the last minute
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_LIMIT_PER_MIN;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) if (!list.some((t) => now - t < 60_000)) hits.delete(ip);
}, 60_000).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request too large (30 MB max). Attach fewer or smaller files."), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (messages[0].role !== "user") return false;
  return messages.every(
    (m) => m && (m.role === "user" || m.role === "assistant") && (typeof m.content === "string" || Array.isArray(m.content)),
  );
}

// Checks the parsed create_file input. With eager input streaming the API doesn't validate it for us.
function checkFileInput(input) {
  if (!input || typeof input !== "object") return "input is not an object";
  if (typeof input.filename !== "string" || !input.filename.trim()) return "filename must be a non-empty string";
  if (typeof input.content !== "string") return "content must be a string";
  if (input.encoding !== undefined && input.encoding !== "utf8" && input.encoding !== "base64")
    return 'encoding must be "utf8" or "base64"';
  if (input.encoding === "base64" && !/^[A-Za-z0-9+/=\s]*$/.test(input.content)) return "content is not valid base64";
  return null;
}

function safeFilename(name) {
  const base = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  return (base || "file.txt").slice(0, 120);
}

// ---------- the chat endpoint ----------
async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status ? err.message : "Body must be JSON" });
  }

  const { messages } = body;
  if (!validMessages(messages)) return sendJson(res, 400, { error: "messages must be a non-empty array starting with a user message" });
  const model = MODELS[body.model] ? body.model : DEFAULT_MODEL;
  const effort = EFFORTS.has(body.effort) ? body.effort : "medium";

  // Server-sent events back to the extension.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);

  const abort = new AbortController();
  res.on("close", () => abort.abort()); // extension closed the panel or hit Stop

  const convo = [...messages];
  const newMessages = []; // what the extension appends to its history
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let stopReason = null;
  let retries = 0;

  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const params = {
        model,
        max_tokens: 64000,
        system: SYSTEM_PROMPT,
        tools: [CREATE_FILE_TOOL],
        messages: convo,
        output_config: { effort },
        cache_control: { type: "ephemeral" }, // caches the conversation so far; later turns are cheaper
      };
      if (MODELS[model].fallbacks) {
        // If a safety classifier declines, the API reruns the request on a fallback model in the same call.
        params.betas = ["server-side-fallback-2026-07-01"];
        params.fallbacks = "default";
      }

      send("turn_start", { turn });
      const stream = client.beta.messages.stream(params, { signal: abort.signal });
      stream.on("text", (delta) => send("text", { delta }));
      stream.on("contentBlock", (block) => {
        if (block.type === "tool_use" && block.name === "create_file") send("file_pending", {});
      });

      let message;
      try {
        message = await stream.finalMessage();
        retries = 0;
      } catch (err) {
        // Unparseable tool JSON or a dropped connection: re-issue the same turn (API errors are rethrown).
        if (err instanceof Anthropic.APIError || abort.signal.aborted || retries++ >= 2) throw err;
        send("retry", { turn });
        turn--;
        continue;
      }

      // Every API call is billed, so report each one right away (the extension keeps the running totals).
      const u = {
        model: message.model || model, // the model that answered (differs from the request after a fallback)
        input_tokens: message.usage.input_tokens || 0,
        output_tokens: message.usage.output_tokens || 0,
        cache_read_input_tokens: message.usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: message.usage.cache_creation_input_tokens || 0,
      };
      send("usage", u);
      for (const k of Object.keys(usage)) usage[k] += u[k];
      stopReason = message.stop_reason;

      const assistantMsg = { role: "assistant", content: message.content };
      if (message.stop_reason === "pause_turn") {
        convo.push(assistantMsg);
        newMessages.push(assistantMsg);
        continue;
      }

      const toolUses = message.content.filter((b) => b.type === "tool_use");
      if (message.stop_reason === "refusal") {
        send("notice", { message: "Claude declined this request." });
        break;
      }
      if (toolUses.length === 0) {
        convo.push(assistantMsg);
        newMessages.push(assistantMsg);
        if (message.stop_reason === "max_tokens") send("notice", { message: "The reply hit the length limit and was cut off." });
        break;
      }
      if (message.stop_reason === "max_tokens") {
        // A file cut off mid-way still parses, so never deliver it.
        send("notice", { message: "A file was cut off by the length limit. Ask for a smaller file or split it up." });
        break;
      }

      convo.push(assistantMsg);
      newMessages.push(assistantMsg);

      const results = [];
      for (const tu of toolUses) {
        if (tu.name !== "create_file") {
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Unknown tool ${tu.name}` });
          continue;
        }
        const problem = checkFileInput(tu.input);
        if (problem) {
          results.push({
            type: "tool_result", tool_use_id: tu.id, is_error: true,
            content: `INVALID_INPUT: ${problem}. Call create_file again with valid JSON.`,
          });
          continue;
        }
        const filename = safeFilename(tu.input.filename);
        const encoding = tu.input.encoding || "utf8";
        const data = encoding === "base64"
          ? tu.input.content.replace(/\s+/g, "")
          : Buffer.from(tu.input.content, "utf8").toString("base64");
        const bytes = Buffer.from(data, "base64").length;
        send("file", { filename, mime_type: tu.input.mime_type || "", data_base64: data, bytes });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: `Delivered ${filename} (${bytes} bytes) to the user as a download.` });
      }
      const resultsMsg = { role: "user", content: results };
      convo.push(resultsMsg);
      newMessages.push(resultsMsg);
      if (turn === MAX_TOOL_TURNS - 1) send("notice", { message: "Stopped after too many file steps in one reply." });
    }

    send("done", { new_messages: newMessages, stop_reason: stopReason, usage, model });
  } catch (err) {
    if (!abort.signal.aborted) {
      let msg = "Something went wrong talking to Anthropic.";
      if (err instanceof Anthropic.AuthenticationError) msg = "The relay's ANTHROPIC_API_KEY was rejected. Check it on the server.";
      else if (err instanceof Anthropic.RateLimitError) msg = "Anthropic rate limit hit. Wait a moment and try again.";
      else if (err instanceof Anthropic.BadRequestError) msg = `Anthropic rejected the request: ${err.message}`;
      else if (err instanceof Anthropic.APIError) msg = `Anthropic API error ${err.status}: ${err.message}`;
      console.error("[chat]", err?.status || "", err?.message || err);
      send("error", { message: msg });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(originAllowed(req.headers.origin) ? 204 : 403);
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true });

  if (url.pathname === "/v1/chat" || url.pathname === "/v1/check") {
    if (!originAllowed(req.headers.origin)) return sendJson(res, 403, { error: "Origin not allowed" });
    if (!tokenOk(req.headers.authorization)) return sendJson(res, 401, { error: "Wrong relay token" });
    if (url.pathname === "/v1/check") return sendJson(res, 200, { ok: true, models: Object.keys(MODELS), default_model: DEFAULT_MODEL });
    if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
    if (rateLimited(ip)) return sendJson(res, 429, { error: "Too many requests to the relay. Wait a minute." });
    return handleChat(req, res);
  }

  sendJson(res, 404, { error: "Not found" });
});

server.requestTimeout = 0; // long streamed replies are fine
server.headersTimeout = 60_000;
server.listen(PORT, () => console.log(`Claude relay listening on :${PORT}`));
