import * as vscode from 'vscode';
import axios from 'axios';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    let apiBase = vscode.workspace.getConfiguration('quant2').get('apiUrl', 'http://localhost:8000') as string;
    let repoId = 'quant2-repo'; // TODO: git rev-parse --show-toplevel
    
    // 1. Autocomplete w/ repo context
    const provider: vscode.InlineCompletionItemProvider<vscode.InlineCompletionItem> = {
        provideInlineCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.InlineCompletionList> {
            // Async impl with timeout/cancel
            // (existing logic from previous)
        }
    };
    
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider));
    
    // 2. Sidebar Chat
    const viewProvider = new QuantChatProvider(context.extensionUri, apiBase);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('quant2-chat', viewProvider));
    
    // Commands
    context.subscriptions.push(vscode.commands.registerCommand('quant2.chat', () => {
        viewProvider.postMessage({ command: 'focus' });
    }));
    
    // Statusbar
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'quant2.chat';
    statusBar.text = '🤖 Quant_2';
    statusBar.tooltip = 'AI Assistant';
    statusBar.show();
}

class QuantChatProvider implements vscode.WebviewViewProvider {
    constructor(private extensionUri: vscode.Uri, private apiBase: string) {}
    
    resolveWebviewView(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();
        
        webviewView.webview.onDidReceiveMessage(async data => {
            if (data.command === 'chat') {
                await this.handleChat(data.text);
            }
        });
    }
    
    private async handleChat(message: string) {
        // Capture context
        const openFiles = vscode.workspace.textDocuments.map(d => ({
            path: d.uri.fsPath,
            language: d.languageId,
            selection: vscode.window.activeTextEditor?.selection
        }));
        
        const stream = await axios.post(`${this.apiBase}/v1/chat`, {
            message,
            open_files: openFiles,
            repo_id: repoId
        }, { responseType: 'stream' });
        
        // Stream to webview
    }
    
    private getHtml(): string {
        return `
        <!DOCTYPE html>
        <html>
        <head><style>body { font-family: var(--vscode-font-family); padding: 10px; }</style></head>
        <body>
            <div id="messages"></div>
            <div>
                <input id="input" placeholder="Describe your code problem..." style="flex:1;">
                <button onclick="send()">Send</button>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                function send() {
                    const input = document.getElementById('input');
                    vscode.postMessage({command: 'chat', text: input.value});
                    input.value = '';
                }
                document.getElementById('input').addEventListener('keypress', e => {
                    if (e.key === 'Enter') send();
                });
            </script>
        </body>
        </html>`;
    }
}

export function deactivate() {}
