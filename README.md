# Copilot Chat Export — User Guide

A VS Code extension that **automatically captures your GitHub Copilot Chat conversations** and saves them as markdown files for later review, searching, and analysis. Optionally syncs exports to a GitHub repository.

---

## Table of Contents

- [Installation](#installation)
- [How It Works](#how-it-works)
- [Commands](#commands)
- [Settings](#settings)
- [GitHub Sync Setup](#github-sync-setup)
- [File Output Format](#file-output-format)
- [Troubleshooting](#troubleshooting)
- [Rebuilding the Extension](#rebuilding-the-extension)

---

## Installation

### Install from Release (`.vsix`)

#### Via Command Line

```bash
code --install-extension copilot-chat-export-0.1.0.vsix --force
```

#### Via VS Code UI

1. Open VS Code
2. Press `Ctrl+Shift+P` → type **"Install from VSIX"**
3. Browse to the `.vsix` file and select it
4. Reload VS Code when prompted

### Install from Source

```bash
git clone https://github.com/riegnman/copilot-chat-export.git
cd copilot-chat-export
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
code --install-extension copilot-chat-export-0.1.0.vsix --force
```

---

## How It Works

Once installed and VS Code is reloaded, the extension runs automatically in the background:

1. **On startup**, it scans all VS Code workspace storage directories for Copilot Chat session files (`.json` and `.jsonl` format).
2. **File watchers** monitor those directories — whenever a chat session is created or updated, the extension automatically exports it to a markdown file after a 5-second debounce (to wait for writes to settle).
3. **Exported markdown files** are saved to a `.copilot-chats/` folder in your first workspace root.
4. **Auto-commit** (optional, enabled by default): Each export is automatically committed to a local git repo inside the `.copilot-chats/` folder.
5. **Manual push**: When you're ready, use the push command to send all commits to your configured GitHub repo.

A status bar indicator **"Chat Export"** appears on the right side of the VS Code status bar. It briefly shows the filename when a new export is saved.

---

## Commands

Access all commands via the Command Palette (`Ctrl+Shift+P`) and search for **"Copilot Chat Export"**.

| Command | Description |
|---------|-------------|
| **Export Copilot Chat to Markdown** | Force re-export all chat sessions (clears export cache and re-processes everything). Keyboard shortcut: `Ctrl+Shift+E` when chat is visible. |
| **Export Current Chat Session** | Export only the most recently modified chat session. |
| **Open Chat Exports Folder** | Opens the `.copilot-chats/` directory in your system file explorer. Also accessible by clicking the status bar indicator. |
| **Push Chat Exports to GitHub** | Commits any uncommitted files and pushes to your configured GitHub remote. |
| **Show Chat Exports Git Status** | Displays git status info (branch, remote, last commit, pending changes) in the Output panel. |

---

## Settings

Open VS Code Settings (`Ctrl+,`) and search for **"copilotChatExport"** to configure the extension.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `copilotChatExport.outputFolder` | string | `.copilot-chats` | Folder name (relative to workspace root) where chat exports are saved. |
| `copilotChatExport.includeTimestamp` | boolean | `true` | Include timestamp in the exported markdown header. |
| `copilotChatExport.addToGitignore` | boolean | `true` | Automatically add the exports folder to the workspace's `.gitignore` so chat exports don't get committed to your project repo. |
| `copilotChatExport.gitRemoteUrl` | string | *(empty)* | GitHub repository URL for syncing exports. Supports HTTPS (`https://github.com/user/repo.git`) and SSH (`git@github.com:user/repo.git`). Leave empty to disable git sync. |
| `copilotChatExport.gitBranch` | string | `main` | Git branch name to push chat exports to. |
| `copilotChatExport.autoCommit` | boolean | `true` | Automatically commit to the local git repo after each export. Push is always manual. |
| `copilotChatExport.vscodeDataPath` | string | *(empty)* | Custom path to your VS Code `User` data directory (contains `workspaceStorage/`). Leave empty to auto-detect. See [Platform Paths](#platform-paths) below. |

### Platform Paths

The extension **auto-detects** the correct VS Code data directory for your OS. You only need to set `copilotChatExport.vscodeDataPath` if auto-detection fails (e.g., portable install, non-standard location).

| OS | Default auto-detected path |
|----|---|
| **Windows** | `%APPDATA%\Code\User` |
| **macOS** | `~/Library/Application Support/Code/User` |
| **Linux** | `~/.config/Code/User` (or `$XDG_CONFIG_HOME/Code/User`) |

> For **VS Code Insiders**, the folder is `Code - Insiders` instead of `Code`. This is detected automatically.

### Example `settings.json`

```json
{
    "copilotChatExport.outputFolder": ".copilot-chats",
    "copilotChatExport.gitRemoteUrl": "https://github.com/yourusername/copilot-chats.git",
    "copilotChatExport.gitBranch": "main",
    "copilotChatExport.autoCommit": true,
    "copilotChatExport.addToGitignore": true
}
```

---

## GitHub Sync Setup

### Step 1: Create a GitHub Repository

1. Go to [github.com/new](https://github.com/new)
2. Create a new repository (e.g., `copilot-chats`)
3. It can be **private** — your chat history may contain sensitive context
4. **Do not** initialize with a README (the extension will handle the first commit)

### Step 2: Configure the Extension

Open VS Code Settings (`Ctrl+,`) and set:

- **`copilotChatExport.gitRemoteUrl`** → your repo URL  
  - HTTPS: `https://github.com/yourusername/copilot-chats.git`
  - SSH: `git@github.com:yourusername/copilot-chats.git`

### Step 3: Push When Ready

1. Press `Ctrl+Shift+P`
2. Type **"Push Chat Exports to GitHub"**
3. The extension will:
   - Initialize the git repo (if first time)
   - Commit any uncommitted exports
   - Push to your configured remote and branch

### Authentication

The extension uses the system `git` command, so it relies on your existing git credentials:

- **HTTPS**: Git credential manager (usually configured automatically with GitHub Desktop or `git config --global credential.helper manager`)
- **SSH**: SSH keys configured in `~/.ssh/` and added to your GitHub account

If you can `git push` from the command line to your GitHub repo, the extension will work.

---

## File Output Format

Exported markdown files are named with the pattern:

```
{ISO-timestamp}_{title-slug}.md
```

Example: `2026-03-03_17-04-03-390_vs-code-path-update-confirmation.md`

### Markdown Structure

Each exported file contains:

```markdown
# Chat Session Title

| Property | Value |
|----------|-------|
| **Date** | Monday, March 3, 2026 |
| **Time** | 05:04:03 PM |
| **Session ID** | `866b4246-...` |
| **Workspace** | wow, yambms-1, jenkins |
| **Responder** | GitHub Copilot |

---

## 🧑 User (Message 1)

The user's question or request...

## 🤖 GitHub Copilot (Response 1)

The assistant's response...

---

(more messages...)

*Auto-exported by Copilot Chat Export extension at 2026-03-03T17:30:00.000Z*
```

**What's included:**
- User messages (with internal context/XML tags stripped out)
- Assistant responses (with thinking markers and internal data removed)
- Tool usage notes (e.g., "Ran terminal command", "Read file")
- Model information when available

---

## Troubleshooting

### Check the Output Panel

The extension logs detailed information to the **"Copilot Chat Export"** output channel:

1. Press `Ctrl+Shift+P` → **"Show Chat Exports Git Status"** (opens the panel automatically)
2. Or: **View** → **Output** → select **"Copilot Chat Export"** from the dropdown

### Common Issues

| Problem | Solution |
|---------|----------|
| No files exported | Make sure you have a workspace folder open. The extension saves to the first workspace folder's root. |
| Extension not activating | Reload VS Code (`Ctrl+Shift+P` → "Reload Window"). Check that the extension is installed (`code --list-extensions \| Select-String copilot-chat-export`). |
| Push fails with auth error | Ensure your git credentials are configured. Try `git push` manually from the `.copilot-chats/` folder to test. |
| Push fails with "remote rejected" | Make sure the GitHub repo exists and you have write access. For a new empty repo, the first push may need `git push -u origin main`. |
| Exports folder not found | The folder is created on the first export. Start or continue a Copilot Chat conversation and wait a few seconds. |
| Old sessions not exporting | Use "Export Copilot Chat to Markdown" to force re-export all sessions (this clears the cache). |

### Reset Export History

If you want to force re-export everything:
1. `Ctrl+Shift+P` → **"Export Copilot Chat to Markdown"**
2. This clears the internal tracking and re-processes all chat session files

---

## Rebuilding the Extension

If you modify the source code, rebuild and reinstall:

```bash
# Navigate to the project directory
cd copilot-chat-export

# Install dependencies (first time only)
npm install

# Compile TypeScript
npm run compile

# Package into .vsix
npx @vscode/vsce package --allow-missing-repository

# Install into VS Code
code --install-extension copilot-chat-export-0.1.0.vsix --force
```

Then reload VS Code (`Ctrl+Shift+P` → "Reload Window").

### Project Structure

```
copilot-chat-export/
├── src/
│   └── extension.ts          # Main extension source
├── out/
│   └── extension.js          # Compiled JavaScript (generated)
├── package.json               # Extension manifest and settings
├── tsconfig.json              # TypeScript configuration
├── .vscodeignore              # Files excluded from .vsix package
└── copilot-chat-export-0.1.0.vsix  # Packaged extension
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | March 2026 | Initial release — auto-export, manual commands, GitHub sync with configurable remote, auto-commit with manual push |
