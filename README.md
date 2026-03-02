# VibeCode TWS — AI Coding Assistant

A VS Code extension that lets your organisation's developers chat with top AI models using **their own API keys** — no shared credentials, full control.

---

## ✨ Features

| Feature | Details |
|---|---|
| 🤖 **Multiple AI Models** | GPT-4o, GPT-4 Turbo, GPT-3.5 Turbo, Claude 3.5 Sonnet, Claude 3 Haiku, Gemini 1.5 Pro/Flash |
| 🔑 **Custom API Keys** | Each user stores their own key securely in VS Code's Secret Storage (never in plaintext) |
| 💬 **Chat Panel** | Full conversation history with code formatting |
| ⚡ **Status Bar** | One-click access showing current model |
| ⌨️ **Keyboard Shortcut** | `Ctrl+Shift+V` / `Cmd+Shift+V` to open chat |
| ⚙️ **Per-user Settings** | Temperature, max tokens, system prompt — all configurable |

---

## 🚀 Getting Started

### 1. Install
- Download the `.vsix` from Releases and install via **Extensions › Install from VSIX**
- Or clone this repo and run `npm install && npm run compile` then **F5** to launch.

### 2. Set your API Key
Open the Command Palette (`Ctrl+Shift+P`) and run:
```
VibeCode: Set API Key
```
Choose your provider (OpenAI / Anthropic / Google) and paste your key. It is stored in VS Code's encrypted **Secret Storage** — never written to disk in plaintext.

### 3. Select a Model
```
VibeCode: Select AI Model
```
Or click the model name in the **status bar** (bottom right).

### 4. Open Chat
```
VibeCode: Open AI Chat
```
Or press `Ctrl+Shift+V`.

---

## 🧠 Supported Models

| Model | Provider | Context | Best for |
|---|---|---|---|
| GPT-4o | OpenAI | 128k | General, coding (recommended) |
| GPT-4 Turbo | OpenAI | 128k | Complex reasoning |
| GPT-3.5 Turbo | OpenAI | 16k | Fast, cost-effective |
| Claude 3.5 Sonnet | Anthropic | 200k | Code, analysis |
| Claude 3 Haiku | Anthropic | 200k | Fast responses |
| Gemini 1.5 Pro | Google | 1M | Large codebase analysis |
| Gemini 1.5 Flash | Google | 1M | Fast, large context |

---

## ⚙️ Settings

| Setting | Default | Description |
|---|---|---|
| `vibecode.selectedModel` | `gpt-4o` | Active AI model |
| `vibecode.maxTokens` | `2048` | Max response tokens |
| `vibecode.temperature` | `0.7` | Creativity (0–2) |
| `vibecode.systemPrompt` | *Expert engineer prompt* | System instructions |

---

## 🔒 Security & Privacy

- API keys are stored using **VS Code SecretStorage** (OS keychain / encrypted storage)
- Keys are **never** logged, committed, or sent anywhere except the respective AI provider API
- Each developer uses their own key — no shared org credentials

---

## 🏗️ Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode
npm run watch

# Launch extension in debug mode
# Press F5 in VS Code
```

### Build & Package
```bash
npm install -g @vscode/vsce
vsce package        # produces vibecode-tws-x.x.x.vsix
```

---

## 📁 Project Structure

```
VibeCode_TWS/
├── src/
│   ├── extension.ts        # Entry point, commands, status bar
│   ├── models.ts           # Supported models registry
│   ├── apiClient.ts        # OpenAI / Anthropic / Google API calls
│   └── webview/
│       └── chatPanel.ts    # Webview panel with embedded HTML/CSS/JS
├── media/
│   └── icon.svg
├── package.json            # Extension manifest
└── tsconfig.json
```

---

## 📄 License

MIT
