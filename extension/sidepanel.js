// Claude Relay side panel. Talks only to your relay server, never to Anthropic directly.

// ---------- storage (chrome.storage, or localStorage when previewed as a plain page) ----------
const store = {
  async get(key, fallback) {
    if (globalThis.chrome?.storage?.local) {
      const r = await chrome.storage.local.get(key);
      return r[key] ?? fallback;
    }
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  },
  async set(key, value) {
    if (globalThis.chrome?.storage?.local) return chrome.storage.local.set({ [key]: value });
    localStorage.setItem(key, JSON.stringify(value));
  },
};

const $ = (id) => document.getElementById(id);
const els = {
  settings: $("settings"), relayUrl: $("relayUrl"), relayToken: $("relayToken"), model: $("model"), effort: $("effort"),
  settingsStatus: $("settingsStatus"), log: $("log"), empty: $("empty"), attachments: $("attachments"),
  input: $("input"), sendBtn: $("sendBtn"), fileInput: $("fileInput"), composerStatus: $("composerStatus"),
  dropzone: $("dropzone"),
};

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_CHARS = 29 * 1024 * 1024; // the relay accepts 30 MB
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

let settings = { relayUrl: "", relayToken: "", model: "claude-opus-5-5", effort: "medium" };
let history = [];     // the exact API messages (content blocks), sent back each turn
let transcript = [];  // what the panel shows
let pending = [];     // attachments waiting to be sent: { name, size, block }
let controller = null;

// ---------- small helpers ----------
function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function setStatus(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function baseUrl() {
  return settings.relayUrl.trim().replace(/\/+$/, "");
}

// Small markdown renderer: code fences, inline code, bold, links, lists, paragraphs.
function renderMarkdown(src) {
  const parts = src.split(/```/);
  let html = "";
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const code = part.replace(/^[^\n]*\n/, ""); // drop the language tag line
      html += `<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`;
      return;
    }
    const blocks = part.split(/\n{2,}/);
    for (const block of blocks) {
      if (!block.trim()) continue;
      const lines = block.split("\n");
      const inline = (t) => escapeHtml(t)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      if (lines.every((l) => /^\s*[-*] /.test(l))) {
        html += "<ul>" + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("") + "</ul>";
      } else if (lines.every((l) => /^\s*\d+[.)] /.test(l))) {
        html += "<ol>" + lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ""))}</li>`).join("") + "</ol>";
      } else if (/^#{1,4} /.test(lines[0]) && lines.length === 1) {
        html += `<p><strong>${inline(lines[0].replace(/^#+ /, ""))}</strong></p>`;
      } else {
        html += `<p>${lines.map(inline).join("<br>")}</p>`;
      }
    }
  });
  return html;
}

function guessMime(filename, given) {
  if (given) return given;
  const ext = filename.split(".").pop().toLowerCase();
  return ({
    txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html",
    css: "text/css", js: "text/javascript", svg: "image/svg+xml", xml: "application/xml", png: "image/png",
    jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf", py: "text/x-python",
  })[ext] || "application/octet-stream";
}

function downloadFile(file) {
  const bin = atob(file.data_base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: guessMime(file.filename, file.mime_type) }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- rendering ----------
function renderEntry(entry) {
  const div = document.createElement("div");
  div.className = `msg ${entry.role}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = entry.role === "user" ? "You" : "Claude";
  const body = document.createElement("div");
  body.className = "body";
  div.append(who, body);
  fillEntry(div, entry);
  return div;
}

function fillEntry(div, entry) {
  const body = div.querySelector(".body");
  if (entry.role === "user") {
    body.innerHTML = entry.text ? `<p>${escapeHtml(entry.text).replace(/\n/g, "<br>")}</p>` : "";
  } else {
    body.innerHTML = entry.text ? renderMarkdown(entry.text) : (entry.streaming ? '<p class="typing">Thinking…</p>' : "");
  }
  div.querySelectorAll(".sent-files, .files, .notice").forEach((n) => n.remove());

  if (entry.attachments?.length) {
    const p = document.createElement("p");
    p.className = "sent-files";
    p.textContent = `Attached: ${entry.attachments.join(", ")}`;
    div.append(p);
  }
  if (entry.files?.length) {
    const ul = document.createElement("ul");
    ul.className = "files";
    entry.files.forEach((f) => {
      const li = document.createElement("li");
      li.className = "file";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = f.filename;
      name.title = f.filename;
      const size = document.createElement("span");
      size.className = "size";
      size.textContent = fmtSize(f.bytes);
      const btn = document.createElement("button");
      btn.textContent = "Download";
      btn.addEventListener("click", () => downloadFile(f));
      li.append(name, size, btn);
      ul.append(li);
    });
    div.append(ul);
  }
  if (entry.pendingFile) {
    const p = document.createElement("p");
    p.className = "notice";
    p.textContent = "Writing a file…";
    div.append(p);
  }
  for (const n of entry.notices || []) {
    const p = document.createElement("p");
    p.className = `notice${n.error ? " error" : ""}`;
    p.textContent = n.text;
    div.append(p);
  }
}

function renderAll() {
  els.log.querySelectorAll(".msg").forEach((n) => n.remove());
  els.empty.hidden = transcript.length > 0;
  transcript.forEach((e) => els.log.append(renderEntry(e)));
  els.log.scrollTop = els.log.scrollHeight;
}

function renderPending() {
  els.attachments.innerHTML = "";
  pending.forEach((a, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = a.name;
    name.title = a.name;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = fmtSize(a.size);
    const rm = document.createElement("button");
    rm.className = "link";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => { pending.splice(i, 1); renderPending(); });
    li.append(name, size, rm);
    els.attachments.append(li);
  });
}

// ---------- attachments ----------
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function fileToBlock(file) {
  const buf = await file.arrayBuffer();
  const type = file.type || "";
  if (IMAGE_TYPES.has(type)) {
    return { type: "image", source: { type: "base64", media_type: type, data: toBase64(buf) } };
  }
  if (type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return { type: "document", title: file.name, source: { type: "base64", media_type: "application/pdf", data: toBase64(buf) } };
  }
  // Anything that decodes as UTF-8 text (code, csv, json, md, logs...) goes in as a text document.
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    if (text.includes("\u0000")) throw new Error("binary");
    return { type: "document", title: file.name, source: { type: "text", media_type: "text/plain", data: text || " " } };
  } catch {
    return null;
  }
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (file.size > MAX_FILE_BYTES) {
      setStatus(els.composerStatus, `${file.name} is over 20 MB, so it can't be sent.`, true);
      continue;
    }
    const block = await fileToBlock(file);
    if (!block) {
      setStatus(els.composerStatus, `${file.name}: Claude can read images (PNG, JPEG, GIF, WebP), PDFs and text files, not this type.`, true);
      continue;
    }
    pending.push({ name: file.name, size: file.size, block });
    setStatus(els.composerStatus, "");
  }
  renderPending();
}

async function addCurrentPage() {
  if (!globalThis.chrome?.scripting) {
    setStatus(els.composerStatus, "Adding a page only works inside the extension.", true);
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ title: document.title, url: location.href, text: document.body?.innerText || "" }),
    });
    const text = `URL: ${result.url}\n\n${result.text}`.slice(0, 400_000);
    pending.push({
      name: `Page: ${result.title || result.url}`,
      size: text.length,
      block: { type: "document", title: result.title || result.url, source: { type: "text", media_type: "text/plain", data: text } },
    });
    setStatus(els.composerStatus, "");
    renderPending();
  } catch {
    setStatus(els.composerStatus, "Couldn't read this tab. Click the extension icon while on the page, then try again. Chrome's own pages (chrome://) can't be read.", true);
  }
}

// ---------- talking to the relay ----------
async function* readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

async function send() {
  if (controller) { controller.abort(); return; } // the Send button is Stop while a reply streams
  const text = els.input.value.trim();
  if (!text && pending.length === 0) return;
  if (!baseUrl() || !settings.relayToken) {
    els.settings.hidden = false;
    setStatus(els.settingsStatus, "Add your relay URL and token first.", true);
    return;
  }

  const content = pending.map((a) => a.block);
  if (text) content.push({ type: "text", text });
  else content.push({ type: "text", text: "Here are the attached files." });
  const userMsg = { role: "user", content };
  const requestHistory = [...history, userMsg];
  const body = JSON.stringify({ messages: requestHistory, model: settings.model, effort: settings.effort });
  if (body.length > MAX_REQUEST_CHARS) {
    setStatus(els.composerStatus, "This chat plus the attachments is over the 30 MB limit. Start a new chat or attach less.", true);
    return;
  }

  const userEntry = { role: "user", text, attachments: pending.map((a) => a.name) };
  const reply = { role: "assistant", text: "", files: [], notices: [], streaming: true };
  transcript.push(userEntry, reply);
  pending = [];
  els.input.value = "";
  renderPending();
  setStatus(els.composerStatus, "");
  renderAll();
  const replyDiv = els.log.lastElementChild;
  const refresh = () => { fillEntry(replyDiv, reply); els.log.scrollTop = els.log.scrollHeight; };

  controller = new AbortController();
  els.sendBtn.textContent = "Stop";
  let turnStartLen = 0;
  let finished = false;

  try {
    const res = await fetch(`${baseUrl()}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.relayToken}` },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Relay answered ${res.status}`);
    }
    for await (const { event, data } of readSse(res)) {
      if (event === "turn_start") {
        turnStartLen = reply.text.length;
        if (reply.text && !reply.text.endsWith("\n\n")) { reply.text += "\n\n"; turnStartLen = reply.text.length; }
      } else if (event === "text") {
        reply.text += data.delta;
      } else if (event === "retry") {
        reply.text = reply.text.slice(0, turnStartLen); // the relay is re-running that step
      } else if (event === "file_pending") {
        reply.pendingFile = true;
      } else if (event === "file") {
        reply.pendingFile = false;
        reply.files.push(data);
      } else if (event === "notice") {
        reply.notices.push({ text: data.message });
      } else if (event === "error") {
        reply.notices.push({ text: data.message, error: true });
      } else if (event === "done") {
        finished = true;
        history = [...requestHistory, ...data.new_messages];
      }
      refresh();
    }
    if (!finished && !reply.notices.some((n) => n.error)) {
      reply.notices.push({ text: "The connection to the relay closed early.", error: true });
    }
  } catch (err) {
    if (err.name === "AbortError") reply.notices.push({ text: "Stopped." });
    else reply.notices.push({ text: `Couldn't reach the relay: ${err.message}`, error: true });
  } finally {
    // Only a finished reply joins the history; a stopped or failed one is shown but not resent,
    // so the next message starts cleanly from the last complete exchange.
    if (!finished) userEntry.attachments = userEntry.attachments.map((n) => `${n} (not kept)`);
    reply.streaming = false;
    reply.pendingFile = false;
    refresh();
    controller = null;
    els.sendBtn.textContent = "Send";
    await store.set("history", history);
    await store.set("transcript", transcript);
  }
}

// ---------- settings ----------
async function saveSettings() {
  settings = {
    relayUrl: els.relayUrl.value.trim(),
    relayToken: els.relayToken.value.trim(),
    model: els.model.value,
    effort: els.effort.value,
  };
  await store.set("settings", settings);
  setStatus(els.settingsStatus, "Saved.");
}

async function testRelay() {
  await saveSettings();
  if (!baseUrl()) return setStatus(els.settingsStatus, "Add the relay URL first.", true);
  setStatus(els.settingsStatus, "Checking… (a sleeping free Render server can take about a minute to wake up)");
  try {
    const res = await fetch(`${baseUrl()}/v1/check`, { headers: { Authorization: `Bearer ${settings.relayToken}` } });
    const data = await res.json().catch(() => ({}));
    if (res.ok) setStatus(els.settingsStatus, "Connected. The relay accepted your token.");
    else setStatus(els.settingsStatus, data.error || `Relay answered ${res.status}`, true);
  } catch (err) {
    setStatus(els.settingsStatus, `Couldn't reach the relay: ${err.message}`, true);
  }
}

// ---------- wiring ----------
$("toggleSettings").addEventListener("click", () => { els.settings.hidden = !els.settings.hidden; });
$("saveSettings").addEventListener("click", saveSettings);
$("testRelay").addEventListener("click", testRelay);
$("newChat").addEventListener("click", async () => {
  if (controller) controller.abort();
  history = []; transcript = []; pending = [];
  renderPending(); renderAll();
  await store.set("history", history);
  await store.set("transcript", transcript);
});
$("attachBtn").addEventListener("click", () => els.fileInput.click());
$("pageBtn").addEventListener("click", addCurrentPage);
els.fileInput.addEventListener("change", () => { addFiles(els.fileInput.files); els.fileInput.value = ""; });
els.sendBtn.addEventListener("click", send);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!controller) send(); }
});

let dragDepth = 0;
document.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; els.dropzone.hidden = false; } });
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; els.dropzone.hidden = true; } });
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropzone.hidden = true;
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});

(async function init() {
  settings = { ...settings, ...(await store.get("settings", {})) };
  history = await store.get("history", []);
  transcript = (await store.get("transcript", [])).map((t) => ({ ...t, streaming: false, pendingFile: false }));
  els.relayUrl.value = settings.relayUrl;
  els.relayToken.value = settings.relayToken;
  els.model.value = settings.model;
  els.effort.value = settings.effort;
  if (!settings.relayUrl || !settings.relayToken) els.settings.hidden = false;
  renderAll();
})();
