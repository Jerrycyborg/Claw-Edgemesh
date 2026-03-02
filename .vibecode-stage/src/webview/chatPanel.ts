import * as vscode from "vscode";
import { getCompletion, ChatMessage } from "../apiClient";
import { SUPPORTED_MODELS, getModelById, getProviderForModel } from "../models";

const SECRET_KEY_PREFIX = "vibecode.apiKey.";

export class ChatPanel {
  public static currentPanel: ChatPanel | undefined;
  private static readonly viewType = "vibecode.chatView";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _conversationHistory: ChatMessage[] = [];
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(context: vscode.ExtensionContext): ChatPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel._panel.reveal(column);
      return ChatPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(ChatPanel.viewType, "VibeCode AI Chat", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });

    ChatPanel.currentPanel = new ChatPanel(panel, context);
    return ChatPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._context = context;

    this._panel.webview.html = this._getHtml();

    // Send current config to webview on load
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case "ready":
            await this._sendConfig();
            break;
          case "sendMessage":
            await this._handleUserMessage(message.text);
            break;
          case "clearHistory":
            this._conversationHistory = [];
            this._panel.webview.postMessage({ command: "historyCleared" });
            break;
          case "setApiKey":
            await this._promptAndSaveApiKey(message.provider);
            break;
          case "selectModel":
            await this._selectModel();
            break;
        }
      },
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Update webview when config changes
    vscode.workspace.onDidChangeConfiguration(
      async (e) => {
        if (e.affectsConfiguration("vibecode")) {
          await this._sendConfig();
        }
      },
      null,
      this._disposables
    );
  }

  private async _sendConfig() {
    const config = vscode.workspace.getConfiguration("vibecode");
    const modelId = config.get<string>("selectedModel", "gpt-4o");
    const model = getModelById(modelId);
    this._panel.webview.postMessage({
      command: "configUpdate",
      model: modelId,
      modelLabel: model?.label ?? modelId,
      provider: model?.provider ?? "openai",
      models: SUPPORTED_MODELS,
    });
  }

  private async _handleUserMessage(text: string) {
    const config = vscode.workspace.getConfiguration("vibecode");
    const modelId = config.get<string>("selectedModel", "gpt-4o");
    const provider = getProviderForModel(modelId);

    if (!provider) {
      this._panel.webview.postMessage({
        command: "error",
        text: `Unknown model: ${modelId}. Please select a valid model.`,
      });
      return;
    }

    // Resolve API key: SecretStorage first, then Codespaces env vars as fallback
    const envKeyMap: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GOOGLE_API_KEY",
    };
    const storedKey = await this._context.secrets.get(`${SECRET_KEY_PREFIX}${provider}`);
    const apiKey = storedKey || process.env[envKeyMap[provider] ?? ""];
    if (!apiKey) {
      this._panel.webview.postMessage({
        command: "error",
        text: `No API key for ${provider}. Use "VibeCode: Set API Key", or set the ${envKeyMap[provider]} Codespaces secret.`,
      });
      return;
    }

    this._conversationHistory.push({ role: "user", content: text });

    this._panel.webview.postMessage({ command: "thinking", show: true });

    try {
      const result = await getCompletion({
        model: modelId,
        provider,
        apiKey,
        messages: this._conversationHistory,
        maxTokens: config.get<number>("maxTokens", 2048),
        temperature: config.get<number>("temperature", 0.7),
        systemPrompt: config.get<string>("systemPrompt"),
      });

      this._conversationHistory.push({ role: "assistant", content: result.content });

      this._panel.webview.postMessage({
        command: "response",
        text: result.content,
        usage: result.usage,
        model: result.model,
      });
    } catch (err: any) {
      this._conversationHistory.pop(); // remove failed user message
      this._panel.webview.postMessage({
        command: "error",
        text: err.message ?? "Unknown error occurred",
      });
    } finally {
      this._panel.webview.postMessage({ command: "thinking", show: false });
    }
  }

  public async setApiKey(provider?: string) {
    await this._promptAndSaveApiKey(provider);
  }

  private async _promptAndSaveApiKey(provider?: string) {
    const providerChoice =
      provider ??
      (
        await vscode.window.showQuickPick(
          [
            { label: "OpenAI", value: "openai", description: "For GPT-4o, GPT-4, GPT-3.5" },
            {
              label: "Anthropic",
              value: "anthropic",
              description: "For Claude 3.5 Sonnet, Claude 3 Haiku",
            },
            { label: "Google", value: "google", description: "For Gemini 1.5 Pro/Flash" },
          ],
          { placeHolder: "Select provider to set API key for" }
        )
      )?.value;

    if (!providerChoice) {
      return;
    }

    const key = await vscode.window.showInputBox({
      prompt: `Enter your ${providerChoice} API key`,
      password: true,
      placeHolder: "sk-...",
      validateInput: (v) => (v.trim().length < 10 ? "API key seems too short" : null),
    });

    if (!key) {
      return;
    }

    await this._context.secrets.store(`${SECRET_KEY_PREFIX}${providerChoice}`, key.trim());
    vscode.window.showInformationMessage(`✅ VibeCode: API key saved for ${providerChoice}`);
    await this._sendConfig();
  }

  public async selectModel() {
    await this._selectModel();
  }

  private async _selectModel() {
    const items = SUPPORTED_MODELS.map((m) => ({
      label: m.label,
      description: m.description,
      value: m.id,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "Select an AI model",
      matchOnDescription: true,
    });

    if (!selected) {
      return;
    }

    await vscode.workspace
      .getConfiguration("vibecode")
      .update("selectedModel", selected.value, vscode.ConfigurationTarget.Global);

    const model = getModelById(selected.value);
    vscode.window.showInformationMessage(`✅ VibeCode: Model set to ${model?.label}`);
  }

  public dispose() {
    ChatPanel.currentPanel = undefined;
    this._panel.dispose();
    this._disposables.forEach((d) => d.dispose());
  }

  private _getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>VibeCode AI Chat</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --input-border: var(--vscode-input-border);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --panel-bg: var(--vscode-sideBar-background, #1e1e1e);
      --border: var(--vscode-panel-border, #333);
      --user-bubble: var(--vscode-button-background);
      --ai-bubble: var(--vscode-editorWidget-background, #252526);
      --error-fg: var(--vscode-errorForeground, #f44747);
      --muted: var(--vscode-descriptionForeground, #888);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, system-ui);
      font-size: 13px;
      background: var(--bg);
      color: var(--fg);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    /* ── Header ── */
    #header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      background: var(--panel-bg);
      border-bottom: 1px solid var(--border);
      flex-shrink: 0;
    }
    #header h1 { font-size: 14px; font-weight: 600; }
    #header-actions { display: flex; gap: 6px; }
    .icon-btn {
      background: none;
      border: 1px solid var(--border);
      color: var(--fg);
      padding: 3px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .icon-btn:hover { background: var(--btn-hover); }
    /* ── Model bar ── */
    #model-bar {
      padding: 6px 12px;
      background: var(--panel-bg);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
      font-size: 12px;
    }
    #model-label { color: var(--muted); }
    #model-name { font-weight: 600; }
    #model-bar select {
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border, transparent);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 12px;
      cursor: pointer;
      flex: 1;
    }
    /* ── Messages ── */
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .message {
      max-width: 88%;
      padding: 10px 14px;
      border-radius: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message.user {
      align-self: flex-end;
      background: var(--user-bubble);
      color: var(--btn-fg);
      border-bottom-right-radius: 4px;
    }
    .message.assistant {
      align-self: flex-start;
      background: var(--ai-bubble);
      border-bottom-left-radius: 4px;
    }
    .message.error {
      align-self: center;
      background: transparent;
      color: var(--error-fg);
      border: 1px solid var(--error-fg);
      font-size: 12px;
      max-width: 96%;
    }
    .message code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      background: rgba(0,0,0,0.2);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .message pre {
      background: rgba(0,0,0,0.3);
      padding: 10px;
      border-radius: 6px;
      overflow-x: auto;
      margin-top: 6px;
    }
    .message pre code { background: none; padding: 0; }
    .meta {
      font-size: 10px;
      color: var(--muted);
      margin-top: 4px;
      align-self: flex-start;
    }
    /* ── Thinking indicator ── */
    #thinking {
      display: none;
      align-items: center;
      gap: 6px;
      padding: 0 12px 6px;
      color: var(--muted);
      font-size: 12px;
    }
    #thinking.visible { display: flex; }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: bounce 1.2s infinite; }
    .dot:nth-child(2) { animation-delay: 0.2s; }
    .dot:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce { 0%,80%,100%{transform:scale(0.8);opacity:0.5} 40%{transform:scale(1.2);opacity:1} }
    /* ── Input ── */
    #input-area {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      background: var(--panel-bg);
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    #input-row { display: flex; gap: 6px; }
    #user-input {
      flex: 1;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border, transparent);
      border-radius: 6px;
      padding: 8px 10px;
      font-family: inherit;
      font-size: 13px;
      resize: none;
      min-height: 38px;
      max-height: 120px;
      overflow-y: auto;
    }
    #user-input:focus { outline: 1px solid var(--btn-bg); }
    #send-btn {
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 6px;
      padding: 0 14px;
      cursor: pointer;
      font-size: 13px;
      white-space: nowrap;
    }
    #send-btn:hover { background: var(--btn-hover); }
    #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #footer-hint { font-size: 11px; color: var(--muted); text-align: center; }
    /* ── Empty state ── */
    #empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: var(--muted);
      text-align: center;
      padding: 20px;
    }
    #empty-state h2 { font-size: 18px; color: var(--fg); }
    #empty-state p { max-width: 280px; line-height: 1.5; }
    .suggestion-chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 10px; }
    .chip {
      background: var(--ai-bubble);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 5px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .chip:hover { background: var(--btn-hover); }
  </style>
</head>
<body>
  <div id="header">
    <h1>🤖 VibeCode TWS</h1>
    <div id="header-actions">
      <button class="icon-btn" id="key-btn" title="Set API Key">🔑 API Key</button>
      <button class="icon-btn" id="clear-btn" title="Clear conversation">🗑 Clear</button>
    </div>
  </div>

  <div id="model-bar">
    <span id="model-label">Model:</span>
    <select id="model-select" title="Select AI model"></select>
  </div>

  <div id="messages">
    <div id="empty-state">
      <h2>VibeCode AI</h2>
      <p>Your organisation's AI coding assistant. Ask anything about code, architecture, or debugging.</p>
      <div class="suggestion-chips">
        <span class="chip" data-text="Explain this code to me">📖 Explain code</span>
        <span class="chip" data-text="Write unit tests for this function">🧪 Write tests</span>
        <span class="chip" data-text="Review my code for bugs and improvements">🔍 Code review</span>
        <span class="chip" data-text="Help me refactor this code">♻️ Refactor</span>
      </div>
    </div>
  </div>

  <div id="thinking">
    <div class="dot"></div><div class="dot"></div><div class="dot"></div>
    <span>Thinking…</span>
  </div>

  <div id="input-area">
    <div id="input-row">
      <textarea id="user-input" placeholder="Ask anything… (Shift+Enter for new line)" rows="1"></textarea>
      <button id="send-btn">Send ↑</button>
    </div>
    <div id="footer-hint">Enter to send · Shift+Enter for new line</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const emptyState = document.getElementById('empty-state');
    const inputEl = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const thinkingEl = document.getElementById('thinking');
    const modelSelect = document.getElementById('model-select');
    let hasMessages = false;

    // Notify extension we're ready
    vscode.postMessage({ command: 'ready' });

    // ── Model selector ──
    modelSelect.addEventListener('change', () => {
      vscode.postMessage({ command: 'setModel', modelId: modelSelect.value });
    });

    // ── Suggestion chips ──
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        inputEl.value = chip.dataset.text;
        sendMessage();
      });
    });

    // ── API key button ──
    document.getElementById('key-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'setApiKey' });
    });

    // ── Clear button ──
    document.getElementById('clear-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'clearHistory' });
    });

    // ── Send ──
    sendBtn.addEventListener('click', sendMessage);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Auto-resize textarea
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    });

    function sendMessage() {
      const text = inputEl.value.trim();
      if (!text) return;
      appendMessage('user', text);
      vscode.postMessage({ command: 'sendMessage', text });
      inputEl.value = '';
      inputEl.style.height = 'auto';
      sendBtn.disabled = true;
    }

    function appendMessage(role, text, meta) {
      if (!hasMessages) {
        emptyState.remove();
        hasMessages = true;
      }
      const el = document.createElement('div');
      el.className = 'message ' + role;
      el.innerHTML = formatText(text);
      messagesEl.appendChild(el);
      if (meta) {
        const metaEl = document.createElement('div');
        metaEl.className = 'meta';
        metaEl.textContent = meta;
        messagesEl.appendChild(metaEl);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function formatText(text) {
      // Use hex \x60 for backtick to avoid breaking the outer TS template literal
      var bt = '\x60';
      var bt3Re = new RegExp(bt + bt + bt + '([\\s\\S]*?)' + bt + bt + bt, 'g');
      var bt1Re = new RegExp(bt + '([^' + bt + ']+)' + bt, 'g');
      return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(bt3Re, '<pre><code>$1</code></pre>')
        .replace(bt1Re, '<code>$1</code>');
    }

    // ── Messages from extension ──
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.command) {
        case 'configUpdate':
          // Populate model dropdown
          modelSelect.innerHTML = '';
          (msg.models || []).forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label + ' — ' + m.description;
            opt.selected = m.id === msg.model;
            modelSelect.appendChild(opt);
          });
          break;
        case 'response':
          sendBtn.disabled = false;
          const meta = msg.usage
            ? \`\${msg.model} · \${msg.usage.totalTokens} tokens\`
            : msg.model;
          appendMessage('assistant', msg.text, meta);
          break;
        case 'error':
          sendBtn.disabled = false;
          appendMessage('error', '⚠️ ' + msg.text);
          break;
        case 'thinking':
          thinkingEl.classList.toggle('visible', msg.show);
          break;
        case 'historyCleared':
          messagesEl.innerHTML = '';
          hasMessages = false;
          messagesEl.innerHTML = \`
            <div id="empty-state">
              <h2>VibeCode AI</h2>
              <p>Conversation cleared. Start a new chat!</p>
            </div>\`;
          sendBtn.disabled = false;
          break;
      }
    });

    // Handle model change from webview
    modelSelect.addEventListener('change', () => {
      // Update via VS Code settings
      vscode.postMessage({ command: 'selectModel' });
    });
  </script>
</body>
</html>`;
  }
}
