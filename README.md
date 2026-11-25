# Claude Relay

A Chrome extension for chatting with Claude in a side panel. You can send it files and download the files it makes.
All traffic goes through a small relay server that you host (on Render), so your Anthropic API key never sits in
the browser.

```
Chrome extension  --relay token-->  your relay (Render)  --API key-->  Anthropic API
Chrome extension  <---streamed----  your relay (Render)  <--streamed--  Anthropic API
```

- `relay/`: the Node server. It holds `ANTHROPIC_API_KEY`, checks the relay token and streams replies back.
  When Claude makes a file, it sends that file down to the extension.
- `extension/`: the Chrome side panel extension.
- `render.yaml`: a Render Blueprint that deploys `relay/`.

## 1. Deploy the relay on Render

1. Put this folder in a GitHub repo, private is fine (`git init`, commit, push).
2. In Render, go to **New > Blueprint**, pick the repo, and Render reads `render.yaml`.
3. When asked, paste your Anthropic API key into `ANTHROPIC_API_KEY`.
4. After the deploy, open the service's **Environment** tab and copy the `RELAY_TOKEN` that Render generated.
5. Copy the service URL, for example `https://claude-relay-xxxx.onrender.com`. To check it's live, open `/health`
   on that URL. It should show `{"ok":true}`.

The Blueprint uses Render's free plan. Free services go to sleep after about 15 minutes with no traffic, and the
next message then waits about a minute while the server wakes up. To keep it awake, change `plan: free` to
`plan: starter` in `render.yaml` (paid).

## 2. Load the extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension/` folder.
3. Click the extension's toolbar icon to open the side panel.
4. Paste the relay URL and the relay token, then click **Test connection**.

Optional: to lock the relay to your copy of the extension, copy the extension's ID from `chrome://extensions` and
set `ALLOWED_ORIGINS=chrome-extension://<that id>` on Render. Without this setting, the relay accepts any Chrome
extension that has the token.

## Using it

- **Attach files**: use the button, drag files onto the panel, or paste them. Claude can read images (PNG, JPEG,
  GIF, WebP), PDFs, and any text file (code, CSV, JSON, Markdown, logs). Each file can be up to 20 MB, and each
  message (the whole chat plus attachments) up to 30 MB.
- **Add this page**: sends the visible text of the current tab. If Chrome says it can't read the tab, click the
  toolbar icon while you're on that tab first.
- **Files from Claude**: ask for a file ("export this as a CSV", "write me a script") and it shows up with a
  **Download** button. This works best for text formats (CSV, JSON, HTML, SVG, Markdown, code).
- **Model and effort** are in Settings. The relay only allows Opus 5.5, Sonnet 5.5 and Haiku 5.5.
- **New chat** clears the conversation. Chats are saved in the extension's local storage until you clear them.

## Run the relay locally instead

```bash
cd relay
cp .env.example .env    # fill in ANTHROPIC_API_KEY and RELAY_TOKEN
npm install
node --env-file=.env server.js
```

Then use `http://localhost:8787` as the relay URL.

## Relay API

| Route | What it does |
|---|---|
| `GET /health` | Liveness check for Render, needs no auth |
| `GET /v1/check` | Checks the relay token (`Authorization: Bearer <RELAY_TOKEN>`) |
| `POST /v1/chat` | Body `{ messages, model, effort }`. The reply is a server-sent event stream: `text`, `file`, `notice`, `error` and a final `done` event carrying the new messages to add to the history |

The relay also limits each IP to 20 chats a minute (`RATE_LIMIT_PER_MIN`). If a safety check declines a request
on Opus or Sonnet, Anthropic's server-side fallback reruns it on another model.
