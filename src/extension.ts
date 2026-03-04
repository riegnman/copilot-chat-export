import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, ExecSyncOptionsWithStringEncoding } from 'child_process';

/**
 * Copilot Chat Export Extension
 * 
 * Automatically watches Copilot Chat session files and exports them
 * to markdown in a .copilot-chats/ folder in the workspace root.
 */

interface ChatResponse {
    value?: string;
    kind?: string;
    pastTenseMessage?: { value?: string };
}

interface ChatMessage {
    text: string;
    parts?: Array<{ text?: string; kind?: string }>;
}

interface ChatRequest {
    requestId: string;
    timestamp?: number;
    message: ChatMessage;
    response: ChatResponse[];
    modelId?: string;
}

interface ChatSession {
    version: number;
    sessionId: string;
    creationDate: number;
    lastMessageDate?: number;
    responderUsername?: string;
    requests: ChatRequest[];
    customTitle?: string;
}

interface JsonlEntry {
    kind: number;
    v?: any;
    k?: string[];
}

let exportedSessions: Map<string, number> = new Map();
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let debounceTimers: Map<string, NodeJS.Timeout> = new Map();

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Copilot Chat Export');
    outputChannel.appendLine('Copilot Chat Export extension activated.');

    // Status bar indicator
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = '$(export) Chat Export';
    statusBarItem.tooltip = 'Copilot Chat Auto-Export is active. Click to open exports folder.';
    statusBarItem.command = 'copilot-chat-export.openChatsFolder';
    statusBarItem.show();

    // Restore export history from persistent state
    const saved = context.globalState.get<Record<string, number>>('exportedSessions', {});
    exportedSessions = new Map(Object.entries(saved));

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('copilot-chat-export.exportChat', () => manualExportAll(context)),
        vscode.commands.registerCommand('copilot-chat-export.openChatsFolder', () => openChatsFolder()),
        vscode.commands.registerCommand('copilot-chat-export.exportCurrentSession', () => exportCurrentSession(context)),
        vscode.commands.registerCommand('copilot-chat-export.pushToGitHub', () => pushToGitHub()),
        vscode.commands.registerCommand('copilot-chat-export.gitStatus', () => showGitStatus()),
        statusBarItem,
        outputChannel
    );

    // Start watching for chat file changes
    startWatching(context);

    // Initial scan after a short delay (let VS Code finish starting up)
    setTimeout(() => scanAndExport(context), 5000);
}

// ─── File Watching ──────────────────────────────────────────────

/**
 * Resolve the VS Code user data directory based on platform and configuration.
 * Supports Windows, macOS, and Linux, as well as VS Code Insiders.
 * Users can override via the copilotChatExport.vscodeDataPath setting.
 */
function getVSCodeUserDataPath(): string | undefined {
    const config = vscode.workspace.getConfiguration('copilotChatExport');
    const customPath = config.get<string>('vscodeDataPath', '').trim();
    if (customPath && fs.existsSync(customPath)) {
        return customPath;
    }

    const isInsiders = vscode.env.appName.toLowerCase().includes('insider');
    const folderName = isInsiders ? 'Code - Insiders' : 'Code';

    switch (process.platform) {
        case 'win32': {
            const appData = process.env.APPDATA;
            if (appData) { return path.join(appData, folderName, 'User'); }
            break;
        }
        case 'darwin': {
            const home = process.env.HOME;
            if (home) { return path.join(home, 'Library', 'Application Support', folderName, 'User'); }
            break;
        }
        case 'linux': {
            const configDir = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
            return path.join(configDir, folderName, 'User');
        }
    }
    return undefined;
}

function getChatSessionDirs(): string[] {
    const userDataPath = getVSCodeUserDataPath();
    if (!userDataPath) {
        outputChannel.appendLine('Could not determine VS Code user data path. Set copilotChatExport.vscodeDataPath in settings.');
        return [];
    }

    const wsStorageRoot = path.join(userDataPath, 'workspaceStorage');
    if (!fs.existsSync(wsStorageRoot)) {
        outputChannel.appendLine(`Workspace storage not found at: ${wsStorageRoot}`);
        return [];
    }

    const dirs: string[] = [];
    try {
        for (const entry of fs.readdirSync(wsStorageRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                const chatDir = path.join(wsStorageRoot, entry.name, 'chatSessions');
                if (fs.existsSync(chatDir)) {
                    dirs.push(chatDir);
                }
            }
        }
    } catch (err) {
        outputChannel.appendLine(`Error scanning workspace storage: ${err}`);
    }
    return dirs;
}

function startWatching(context: vscode.ExtensionContext) {
    const chatDirs = getChatSessionDirs();
    outputChannel.appendLine(`Found ${chatDirs.length} workspace storage(s) with chat sessions.`);

    for (const chatDir of chatDirs) {
        try {
            const w = fs.watch(chatDir, { persistent: false }, (eventType, filename) => {
                if (filename && (filename.endsWith('.json') || filename.endsWith('.jsonl'))) {
                    debouncedExport(path.join(chatDir, filename), context);
                }
            });
            context.subscriptions.push({ dispose: () => w.close() });
            outputChannel.appendLine(`Watching: ${chatDir}`);
        } catch (err) {
            outputChannel.appendLine(`Could not watch ${chatDir}: ${err}`);
        }
    }
}

function debouncedExport(filePath: string, context: vscode.ExtensionContext) {
    const existing = debounceTimers.get(filePath);
    if (existing) { clearTimeout(existing); }

    const timer = setTimeout(async () => {
        debounceTimers.delete(filePath);
        await exportSessionFile(filePath, context);
    }, 5000);

    debounceTimers.set(filePath, timer);
}

// ─── Parsing ────────────────────────────────────────────────────

function parseJsonSession(content: string): ChatSession | undefined {
    try {
        return JSON.parse(content) as ChatSession;
    } catch { return undefined; }
}

function parseJsonlSession(content: string): ChatSession | undefined {
    try {
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        if (lines.length === 0) { return undefined; }

        const first: JsonlEntry = JSON.parse(lines[0]);
        if (first.kind !== 0 || !first.v) { return undefined; }

        const session: ChatSession = first.v;

        for (let i = 1; i < lines.length; i++) {
            try {
                const entry: JsonlEntry = JSON.parse(lines[i]);
                if (entry.kind === 1 && entry.k) {
                    setNestedValue(session, entry.k, entry.v);
                } else if (entry.kind === 2 && entry.k) {
                    applyArrayUpdate(session, entry.k, entry.v);
                }
            } catch { /* skip malformed lines */ }
        }

        return session;
    } catch { return undefined; }
}

function setNestedValue(obj: any, keys: string[], value: any) {
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        const idx = parseInt(key);
        if (!isNaN(idx) && Array.isArray(current)) {
            current = current[idx];
        } else if (current && typeof current === 'object') {
            current = current[key];
        } else { return; }
    }
    if (current && typeof current === 'object') {
        const lastKey = keys[keys.length - 1];
        const idx = parseInt(lastKey);
        if (!isNaN(idx) && Array.isArray(current)) {
            current[idx] = value;
        } else {
            current[lastKey] = value;
        }
    }
}

function applyArrayUpdate(obj: any, keys: string[], value: any) {
    let current = obj;
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const idx = parseInt(key);
        if (!isNaN(idx) && Array.isArray(current)) {
            if (i === keys.length - 1) {
                if (Array.isArray(value)) {
                    current.splice(idx, current.length - idx, ...value);
                } else {
                    current[idx] = value;
                }
                return;
            }
            current = current[idx];
        } else if (current && typeof current === 'object') {
            current = current[key];
        } else { return; }
    }
}

// ─── Markdown Conversion ────────────────────────────────────────

function sessionToMarkdown(session: ChatSession): string {
    const created = new Date(session.creationDate);
    const dateStr = created.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const timeStr = created.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    const title = session.customTitle || 'Chat Session';
    const workspace = vscode.workspace.workspaceFolders?.map(f => f.name).join(', ') || 'Unknown';

    let md = `# ${title}\n\n`;
    md += `| Property | Value |\n|----------|-------|\n`;
    md += `| **Date** | ${dateStr} |\n`;
    md += `| **Time** | ${timeStr} |\n`;
    md += `| **Session ID** | \`${session.sessionId}\` |\n`;
    md += `| **Workspace** | ${workspace} |\n`;
    md += `| **Responder** | ${session.responderUsername || 'GitHub Copilot'} |\n`;
    md += `\n---\n\n`;

    if (!session.requests || session.requests.length === 0) {
        md += `*No messages in this session.*\n`;
        return md;
    }

    for (let i = 0; i < session.requests.length; i++) {
        const req = session.requests[i];
        const num = i + 1;

        const userText = extractUserMessage(req);
        if (userText) {
            md += `## 🧑 User (Message ${num})\n\n${userText}\n\n`;
        }

        if (req.modelId) {
            md += `*Model: ${req.modelId}*\n\n`;
        }

        const responseText = extractResponse(req);
        if (responseText) {
            md += `## 🤖 ${session.responderUsername || 'GitHub Copilot'} (Response ${num})\n\n${responseText}\n\n`;
        }

        md += `---\n\n`;
    }

    md += `\n*Auto-exported by Copilot Chat Export extension at ${new Date().toISOString()}*\n`;
    return md;
}

function extractUserMessage(req: ChatRequest): string {
    let text = req.message?.text || '';

    // Strip internal context XML tags, extract just the user's actual request
    const userRequestMatch = text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/);
    if (userRequestMatch) {
        text = userRequestMatch[1].trim();
    }

    return text;
}

function extractResponse(req: ChatRequest): string {
    if (!req.response || req.response.length === 0) { return ''; }

    const parts: string[] = [];
    for (const part of req.response) {
        // Skip internal markers
        if (part.kind === 'thinking' || part.kind === 'mcpServersStarting') { continue; }

        if (part.value && typeof part.value === 'string') {
            const trimmed = part.value.trim();
            if (trimmed.length > 0) { parts.push(trimmed); }
        }

        // Include tool usage notes
        if (part.kind === 'toolInvocationSerialized' && part.pastTenseMessage?.value) {
            parts.push(`> *${part.pastTenseMessage.value}*`);
        }
    }

    return parts.join('\n\n');
}

// ─── Export Logic ───────────────────────────────────────────────

function getOutputDir(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return undefined; }
    const config = vscode.workspace.getConfiguration('copilotChatExport');
    const folderName = config.get<string>('outputFolder', '.copilot-chats');
    return path.join(folders[0].uri.fsPath, folderName);
}

function generateFilename(session: ChatSession): string {
    const d = new Date(session.creationDate);
    const ds = d.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    const slug = (session.customTitle || 'chat')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 50);
    return `${ds}_${slug}.md`;
}

async function exportSessionFile(filePath: string, context: vscode.ExtensionContext): Promise<boolean> {
    const outputDir = getOutputDir();
    if (!outputDir) { return false; }

    try {
        if (!fs.existsSync(filePath)) { return false; }

        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');

        const session = filePath.endsWith('.jsonl')
            ? parseJsonlSession(content)
            : parseJsonSession(content);

        if (!session?.sessionId || !session.requests?.length) { return false; }

        // Skip if already exported at this version
        const lastExport = exportedSessions.get(session.sessionId);
        if (lastExport && lastExport >= stat.mtimeMs) { return false; }

        const markdown = sessionToMarkdown(session);
        const filename = generateFilename(session);
        const outputPath = path.join(outputDir, filename);

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        fs.writeFileSync(outputPath, markdown, 'utf-8');

        exportedSessions.set(session.sessionId, stat.mtimeMs);
        await saveExportState(context);

        const exportConfig = vscode.workspace.getConfiguration('copilotChatExport');
        if (exportConfig.get<boolean>('addToGitignore', true)) { addToGitignore(); }

        outputChannel.appendLine(`Auto-exported: ${filename}`);
        statusBarItem.text = `$(check) ${filename.substring(0, 35)}`;
        setTimeout(() => { statusBarItem.text = '$(export) Chat Export'; }, 5000);

        // Auto-commit if enabled
        if (exportConfig.get<boolean>('autoCommit', true)) {
            await gitAutoCommit(outputDir, filename);
        }

        return true;
    } catch (err) {
        outputChannel.appendLine(`Error exporting ${filePath}: ${err}`);
        return false;
    }
}

async function saveExportState(context: vscode.ExtensionContext) {
    const obj: Record<string, number> = {};
    exportedSessions.forEach((v, k) => { obj[k] = v; });
    await context.globalState.update('exportedSessions', obj);
}

async function scanAndExport(context: vscode.ExtensionContext) {
    const chatDirs = getChatSessionDirs();
    let exported = 0;

    for (const chatDir of chatDirs) {
        try {
            for (const file of fs.readdirSync(chatDir)) {
                if (file.endsWith('.json') || file.endsWith('.jsonl')) {
                    if (await exportSessionFile(path.join(chatDir, file), context)) {
                        exported++;
                    }
                }
            }
        } catch (err) {
            outputChannel.appendLine(`Error scanning ${chatDir}: ${err}`);
        }
    }

    if (exported > 0) {
        vscode.window.showInformationMessage(
            `Copilot Chat Export: Auto-exported ${exported} session(s).`,
            'Open Folder'
        ).then(action => { if (action === 'Open Folder') { openChatsFolder(); } });
    }

    outputChannel.appendLine(`Scan complete. Exported ${exported} new/updated session(s).`);
}

// ─── Commands ───────────────────────────────────────────────────

async function manualExportAll(context: vscode.ExtensionContext) {
    if (!getOutputDir()) {
        vscode.window.showErrorMessage('No workspace folder open. Please open a folder first.');
        return;
    }

    exportedSessions.clear();
    await saveExportState(context);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Exporting all Copilot Chat sessions...',
        cancellable: false
    }, async () => { await scanAndExport(context); });
}

async function exportCurrentSession(context: vscode.ExtensionContext) {
    const chatDirs = getChatSessionDirs();
    let newest: { path: string; mtime: number } | undefined;

    for (const dir of chatDirs) {
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.json') || f.endsWith('.jsonl')) {
                const fp = path.join(dir, f);
                const mt = fs.statSync(fp).mtimeMs;
                if (!newest || mt > newest.mtime) { newest = { path: fp, mtime: mt }; }
            }
        }
    }

    if (!newest) {
        vscode.window.showInformationMessage('No chat sessions found.');
        return;
    }

    // Remove from tracking so it re-exports
    const content = fs.readFileSync(newest.path, 'utf-8');
    const session = newest.path.endsWith('.jsonl')
        ? parseJsonlSession(content) : parseJsonSession(content);
    if (session?.sessionId) { exportedSessions.delete(session.sessionId); }

    const didExport = await exportSessionFile(newest.path, context);
    if (didExport) {
        vscode.window.showInformationMessage('Current chat session exported!', 'Open File').then(async action => {
            if (action === 'Open File') {
                const dir = getOutputDir();
                if (dir && fs.existsSync(dir)) {
                    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse();
                    if (files.length > 0) {
                        const doc = await vscode.workspace.openTextDocument(path.join(dir, files[0]));
                        await vscode.window.showTextDocument(doc, { preview: false });
                    }
                }
            }
        });
    }
}

function addToGitignore() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) { return; }

    const config = vscode.workspace.getConfiguration('copilotChatExport');
    const folder = config.get<string>('outputFolder', '.copilot-chats');
    const gitignore = path.join(root, '.gitignore');

    try {
        if (fs.existsSync(gitignore)) {
            const content = fs.readFileSync(gitignore, 'utf-8');
            if (!content.includes(`${folder}/`)) {
                fs.appendFileSync(gitignore, `\n# Copilot Chat exports\n${folder}/\n`);
            }
        }
    } catch (err) {
        outputChannel.appendLine(`Could not update .gitignore: ${err}`);
    }
}

async function openChatsFolder() {
    const dir = getOutputDir();
    if (!dir) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
    if (!fs.existsSync(dir)) {
        vscode.window.showInformationMessage('No chat exports yet. They will appear automatically as you chat.');
        return;
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
}

// ─── Git Integration ────────────────────────────────────────────

const gitExecOpts: ExecSyncOptionsWithStringEncoding = { encoding: 'utf-8', timeout: 30000 };

/**
 * Run a git command in the output directory. Returns stdout or undefined on error.
 */
function gitRun(outputDir: string, args: string): string | undefined {
    try {
        const opts = { ...gitExecOpts, cwd: outputDir };
        return execSync(`git ${args}`, opts).trim();
    } catch (err: any) {
        outputChannel.appendLine(`git ${args} failed: ${err.message || err}`);
        return undefined;
    }
}

/**
 * Ensure the output directory is a git repo with the configured remote.
 */
function ensureGitRepo(outputDir: string): boolean {
    const config = vscode.workspace.getConfiguration('copilotChatExport');
    const remoteUrl = config.get<string>('gitRemoteUrl', '');
    if (!remoteUrl) { return false; }

    const gitDir = path.join(outputDir, '.git');

    // Initialize repo if needed
    if (!fs.existsSync(gitDir)) {
        outputChannel.appendLine(`Initializing git repo in ${outputDir}`);
        gitRun(outputDir, 'init');

        const branch = config.get<string>('gitBranch', 'main');
        gitRun(outputDir, `checkout -b ${branch}`);
    }

    // Set or update remote
    const currentRemote = gitRun(outputDir, 'remote get-url origin');
    if (currentRemote !== remoteUrl) {
        if (currentRemote) {
            gitRun(outputDir, `remote set-url origin ${remoteUrl}`);
        } else {
            gitRun(outputDir, `remote add origin ${remoteUrl}`);
        }
        outputChannel.appendLine(`Git remote set to: ${remoteUrl}`);
    }

    return true;
}

/**
 * Auto-commit a newly exported file.
 */
async function gitAutoCommit(outputDir: string, filename: string): Promise<void> {
    if (!ensureGitRepo(outputDir)) { return; }

    const relPath = filename;
    gitRun(outputDir, `add "${relPath}"`);

    // Check if there are staged changes
    const status = gitRun(outputDir, 'status --porcelain');
    if (!status || status.trim().length === 0) { return; }

    const now = new Date().toISOString();
    gitRun(outputDir, `commit -m "Auto-export: ${filename} (${now})"`);
    outputChannel.appendLine(`Git committed: ${filename}`);
}

/**
 * Manual push command — pushes all committed exports to the configured remote.
 */
async function pushToGitHub() {
    const outputDir = getOutputDir();
    if (!outputDir || !fs.existsSync(outputDir)) {
        vscode.window.showErrorMessage('No chat exports to push.');
        return;
    }

    const config = vscode.workspace.getConfiguration('copilotChatExport');
    const remoteUrl = config.get<string>('gitRemoteUrl', '');
    if (!remoteUrl) {
        const setNow = await vscode.window.showWarningMessage(
            'No GitHub remote URL configured. Set it in settings (copilotChatExport.gitRemoteUrl).',
            'Open Settings'
        );
        if (setNow === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'copilotChatExport.gitRemoteUrl');
        }
        return;
    }

    if (!ensureGitRepo(outputDir)) { return; }

    // Commit any uncommitted files first
    gitRun(outputDir, 'add -A');
    const status = gitRun(outputDir, 'status --porcelain');
    if (status && status.trim().length > 0) {
        const now = new Date().toISOString();
        gitRun(outputDir, `commit -m "Manual push: ${now}"`);
    }

    const branch = config.get<string>('gitBranch', 'main');

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Pushing chat exports to ${remoteUrl}...`,
        cancellable: false
    }, async () => {
        const result = gitRun(outputDir, `push -u origin ${branch}`);
        if (result !== undefined) {
            vscode.window.showInformationMessage(`Chat exports pushed to GitHub successfully!`);
            outputChannel.appendLine(`Pushed to ${remoteUrl} (${branch})`);
        } else {
            vscode.window.showErrorMessage(
                'Push failed. Check the "Copilot Chat Export" output channel for details.'
            );
        }
    });
}

/**
 * Show git status of the exports folder.
 */
async function showGitStatus() {
    const outputDir = getOutputDir();
    if (!outputDir || !fs.existsSync(outputDir)) {
        vscode.window.showInformationMessage('No chat exports directory found.');
        return;
    }

    const config = vscode.workspace.getConfiguration('copilotChatExport');
    const remoteUrl = config.get<string>('gitRemoteUrl', '') || '(not configured)';

    const gitDir = path.join(outputDir, '.git');
    if (!fs.existsSync(gitDir)) {
        vscode.window.showInformationMessage(
            `Chat exports at: ${outputDir}\nGit: Not initialized\nRemote: ${remoteUrl}`
        );
        return;
    }

    const status = gitRun(outputDir, 'status --short') || '(clean)';
    const branch = gitRun(outputDir, 'branch --show-current') || 'unknown';
    const logLine = gitRun(outputDir, 'log --oneline -1') || '(no commits)';
    const remote = gitRun(outputDir, 'remote get-url origin') || '(none)';

    const files = fs.readdirSync(outputDir).filter(f => f.endsWith('.md'));

    outputChannel.show();
    outputChannel.appendLine('\n═══ Chat Exports Git Status ═══');
    outputChannel.appendLine(`Directory : ${outputDir}`);
    outputChannel.appendLine(`Files     : ${files.length} markdown exports`);
    outputChannel.appendLine(`Branch    : ${branch}`);
    outputChannel.appendLine(`Remote    : ${remote}`);
    outputChannel.appendLine(`Last commit: ${logLine}`);
    outputChannel.appendLine(`Status:\n${status}`);
    outputChannel.appendLine('═══════════════════════════════\n');

    vscode.window.showInformationMessage(
        `${files.length} exports | Branch: ${branch} | Remote: ${remote}`,
        'Push Now', 'Open Folder'
    ).then(action => {
        if (action === 'Push Now') { pushToGitHub(); }
        if (action === 'Open Folder') { openChatsFolder(); }
    });
}

export function deactivate() {
    debounceTimers.forEach(timer => clearTimeout(timer));
    debounceTimers.clear();
}
