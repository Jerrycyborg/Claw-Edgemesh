import * as vscode from 'vscode';
import { ChatPanel } from './webview/chatPanel';
import { SUPPORTED_MODELS, getModelById } from './models';

const SECRET_KEY_PREFIX = 'vibecode.apiKey.';

export function activate(context: vscode.ExtensionContext) {
  // ── Command: Open Chat ──────────────────────────────────────────────────
  const openChat = vscode.commands.registerCommand('vibecode.openChat', () => {
    ChatPanel.createOrShow(context);
  });

  // ── Command: Set API Key ────────────────────────────────────────────────
  const setApiKey = vscode.commands.registerCommand('vibecode.setApiKey', async () => {
    const providerItems = [
      { label: '$(key) OpenAI', value: 'openai', description: 'For GPT-4o, GPT-4 Turbo, GPT-3.5' },
      { label: '$(key) Anthropic', value: 'anthropic', description: 'For Claude 3.5 Sonnet, Claude 3 Haiku' },
      { label: '$(key) Google', value: 'google', description: 'For Gemini 1.5 Pro, Gemini 1.5 Flash' },
    ];

    const picked = await vscode.window.showQuickPick(providerItems, {
      placeHolder: 'Select the AI provider to set API key for',
      title: 'VibeCode: Set API Key',
    });
    if (!picked) return;

    const key = await vscode.window.showInputBox({
      prompt: `Enter your ${picked.value} API key`,
      password: true,
      placeHolder: picked.value === 'openai' ? 'sk-...' : picked.value === 'anthropic' ? 'sk-ant-...' : 'AIza...',
      title: `VibeCode: ${picked.label} API Key`,
      validateInput: (v) => (v.trim().length < 10 ? 'API key seems too short' : undefined),
    });
    if (!key) return;

    await context.secrets.store(`${SECRET_KEY_PREFIX}${picked.value}`, key.trim());
    vscode.window.showInformationMessage(`✅ VibeCode: API key saved for ${picked.value}`);

    // Open chat if not already open
    if (!ChatPanel.currentPanel) {
      ChatPanel.createOrShow(context);
    }
  });

  // ── Command: Clear API Key ──────────────────────────────────────────────
  const clearApiKey = vscode.commands.registerCommand('vibecode.clearApiKey', async () => {
    const providerItems = [
      { label: 'OpenAI', value: 'openai' },
      { label: 'Anthropic', value: 'anthropic' },
      { label: 'Google', value: 'google' },
    ];

    const picked = await vscode.window.showQuickPick(providerItems, {
      placeHolder: 'Select provider to clear API key for',
      title: 'VibeCode: Clear API Key',
    });
    if (!picked) return;

    await context.secrets.delete(`${SECRET_KEY_PREFIX}${picked.value}`);
    vscode.window.showInformationMessage(`🗑️ VibeCode: API key cleared for ${picked.value}`);
  });

  // ── Command: Select Model ───────────────────────────────────────────────
  const selectModel = vscode.commands.registerCommand('vibecode.selectModel', async () => {
    const config = vscode.workspace.getConfiguration('vibecode');
    const currentModel = config.get<string>('selectedModel', 'gpt-4o');

    const items = SUPPORTED_MODELS.map((m) => ({
      label: (m.id === currentModel ? '$(check) ' : '      ') + m.label,
      description: m.description,
      detail: `Provider: ${m.provider} · Context: ${(m.contextWindow / 1000).toFixed(0)}k tokens`,
      value: m.id,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select AI model',
      title: 'VibeCode: Select Model',
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!selected) return;

    await config.update('selectedModel', selected.value, vscode.ConfigurationTarget.Global);
    const model = getModelById(selected.value);
    vscode.window.showInformationMessage(`✅ VibeCode: Switched to ${model?.label}`);
  });

  // ── Status Bar Item ─────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'vibecode.openChat';
  statusBar.tooltip = 'Open VibeCode AI Chat';
  updateStatusBar(statusBar);
  statusBar.show();

  vscode.workspace.onDidChangeConfiguration(
    (e) => {
      if (e.affectsConfiguration('vibecode.selectedModel')) {
        updateStatusBar(statusBar);
      }
    },
    null,
    context.subscriptions
  );

  context.subscriptions.push(openChat, setApiKey, clearApiKey, selectModel, statusBar);
}

function updateStatusBar(item: vscode.StatusBarItem) {
  const config = vscode.workspace.getConfiguration('vibecode');
  const modelId = config.get<string>('selectedModel', 'gpt-4o');
  const model = getModelById(modelId);
  item.text = `$(hubot) ${model?.label ?? modelId}`;
}

export function deactivate() {}
