import * as vscode from 'vscode';
import axios from 'axios';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    let apiBase = 'http://localhost:8000'; // Local dev
    let repoId = 'default-repo'; // Stub - impl git detection
    
    // 1. ULTRA-LOW LATENCY AUTOCOMPLETE (existing enhanced)
    const provider: vscode.InlineCompletionItemProvider = {
        async provideInlineCompletionItems(document, position, context, token) {
            if (token.isCancellationRequested) return null;
            
            const lineRange = new vscode.Range(
                new vscode.Position(Math.max(0, position.line - 50), 0),
                position
            );
            const prefix = document.getText(lineRange);
            
            const suffixRange = new vscode.Range(
                position,
                new vscode.Position(position.line + 10, document.lineAt(position.line + 10).text.length)
            );
            const suffix = document.getText(suffixRange);
            
            // Capture context for SMART engine
            const openFiles = vscode.workspace.notebookDocuments.map(d => d.uri.fsPath).concat(
                vscode.workspace.textDocuments.map(d => d.uri.fsPath)
            );
            
            try {
                const res = await axios.post(`${apiBase}/v1/autocomplete`, {
                    prefix,
                    suffix,
                    file_path: document.uri.fsPath,
                    repo_id: repoId,
                    open_files: openFiles.slice(0, 10) // Top 10 relevant
                }, { timeout: 150, headers: { 'X-API-Key': 'test_key' } });
                
                return [new vscode.InlineCompletionItem(res.data.suggestion)];
            } catch (err) {
                console.error('Autocomplete error:', err);
                return null;
            }
        }
    };
    
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider)
    );
    
    // 2. CHAT SIDEBAR (Webview)
    let panel: vscode.WebviewPanel | undefined;
    
    const chatCommand = vscode.commands.registerCommand('quant2.openChat', async () => {
        if (panel) {
            panel.reveal(vscode.ViewColumn.Beside);
        } else {
            panel = vscode.window.createWebviewPanel(
                'quant2Chat',
                'Quant_2 AI Chat',
                vscode.ViewColumn.Beside,
                { enableScripts: true }
            );
            
            // HTML w/ chat UI
            panel.webview.html = `
<!DOCTYPE html>
<html>
<body>
    <div id="chat" style="height:100vh; padding:10px;">
        <div id="messages"></div>
        <input id="input" placeholder="Ask about code, debug, refactor..." style="width:100%;">
        <button onclick="sendMessage()">Send</button>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        async function sendMessage() {
            const input = document.getElementById('input');
            const msg = input.value;
            // Capture editor context
            vscode.postMessage({command: 'chat', text: msg});
            input.value = '';
        }
    </script>
</body>
</html>`;
            
            panel.webview.onDidReceiveMessage(async (msg) => {
                if (msg.command === 'chat') {
                    const editor = vscode.window.activeTextEditor;
                    const openFiles = vscode.workspace.textDocuments.map(d => path.basename(d.fileName));
                    
                    const res = await axios.post(`${apiBase}/v1/chat`, {
                        message: msg.text,
                        file_path: editor?.document.uri.fsPath || '',
                        open_files: openFiles,
                        repo_id: repoId
                    }, { 
                        responseType: 'stream',
                        headers: { 'X-API-Key': 'test_key' },
                        timeout: 30000 
                    });
                    
                    // Stream response to webview
                    panel!.webview.postMessage({
                        command: 'addMessage',
                        role: 'assistant',
                        content: res.data // Stream handling simplified
                    });
                }
            });
        }
    });
    
    context.subscriptions.push(chatCommand);
    
    // Status bar
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
    status.command = 'quant2.openChat';
    status.text = '$(sparkle) Quant_2';
    status.show();
}

export function deactivate() {}
