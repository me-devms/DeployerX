# DeployerX

DeployerX is a free, open-source desktop deployment console for managing SSH-based servers, deployment scripts, command templates, FTP/SFTP file workflows, and optional Firebase cloud sync.

It is built for developers, indie hackers, agencies, and small teams who want a practical way to keep server deployment work organized without paying for a hosted deployment platform or giving up control of their workflow.

## Termius Alternative for Open-Source Deployment Workflows

DeployerX can be used as a Termius alternative when your main goal is not only connecting to servers, but also organizing repeatable deployment workflows. Tools like Termius, MobaXterm, WinSCP, and PuTTY are excellent in their own lanes, but DeployerX is designed around one specific idea: manage servers, scripts, templates, file transfer, and optional team sync in one free open-source desktop app.

DeployerX is especially useful if you want:

- A free and open-source server management tool.
- Multiple server/project profiles in one workspace.
- Saved deployment scripts per project.
- Reusable command templates.
- SSH terminal access and FTP/SFTP-style file tools.
- Optional cloud sync through your own Firebase project.
- Team workspaces without making the core app paid.

## DeployerX vs Similar Tools

| Tool | Main focus | Open source / cost | SSH terminal | File transfer | Scripts/templates | Cloud/team sync | Best fit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **DeployerX** | Deployment-focused server workspace | Open source and free app | Yes | Yes, through SSH/SFTP file tools | Yes, project scripts and reusable templates | Optional Firebase cloud workspaces | Developers who want a free open-source Termius-style workflow with deployment automation |
| **Termius** | Modern SSH client with vaults and collaboration | Commercial product with free and paid plans | Yes | Yes, SFTP support | Yes, snippets/automation on paid tiers | Yes, encrypted vault sync and team features | Users who want a polished cross-device SSH client and do not mind a commercial tool |
| **MobaXterm** | Windows remote terminal toolbox | Free Home Edition, paid Professional Edition | Yes | Yes, graphical SFTP browser | Macros and multi-execution | Not the same kind of open-source Firebase-style team sync | Windows power users who need many remote protocols, X11, tunnels, and terminal utilities |
| **WinSCP** | Graphical file transfer client | Free file transfer tool | No full terminal-first workflow | Yes, strong FTP/SFTP/SCP/WebDAV/S3 support | Scripting and task automation | No built-in team deployment workspace | Users who mainly need reliable file transfer and file automation |
| **PuTTY** | Lightweight SSH/Telnet client | Free and open source | Yes | Separate tools like PSCP/PSFTP | Command-line tools, not a visual deployment template workspace | No | Users who want a classic minimal SSH client |

This comparison is not meant to claim DeployerX replaces every feature of these tools. DeployerX is narrower: it focuses on open-source deployment workflows, script reuse, server organization, file operations, and optional cloud sync.

Comparison references: [Termius](https://www.termius.com/), [Termius pricing](https://www.termius.com/pricing), [MobaXterm features](https://mobaxterm.mobatek.net/features.html), [MobaXterm download](https://mobaxterm.mobatek.net/download.html), [WinSCP](https://winscp.net/eng/index.php?LanguageId=1), [PuTTY](https://www.chiark.greenend.org.uk/~sgtatham/putty/).

> Status: early open-source release. The app is functional, but contributors should expect active development and rough edges.

## What DeployerX Does

DeployerX gives you one focused desktop workspace for common server deployment tasks:

- Manage multiple servers and projects from one app.
- Store SSH connection details for each project.
- Run repeatable deployment scripts over SSH.
- Open an interactive SSH terminal inside the app.
- Save reusable command templates.
- Upload a file before running deployment commands.
- Browse local files.
- Browse remote server files through the app's FTP/SFTP tools.
- Upload, download, rename, create folders, open, and delete remote entries.
- Import and export projects.
- Import and export command templates.
- Export or restore a full account backup.
- Use offline/local mode with no cloud dependency.
- Optionally enable Firebase cloud sync for teams and multiple devices.
- Invite team members to a cloud workspace.
- Encrypt SSH passwords and private keys before cloud sync using a team passphrase.

## Why Open Source

Deployment tooling often becomes expensive, locked down, or too heavy for small workflows. DeployerX is intended to stay transparent and community-friendly:

- Free of cost for local use.
- Open source so the code can be inspected and improved.
- No required hosted backend for local/offline mode.
- Optional Firebase cloud mode for people who want sync.
- Practical workflows over marketing-heavy platform features.

## Screens and Core Areas

The app is organized around these areas:

- **Dashboard**: view projects, create projects, import/export projects, and open templates.
- **Project SSH view**: connect to a server, use the embedded terminal, run saved project commands, and save scripts.
- **Project FTP view**: browse remote server files and perform transfer/file operations.
- **Templates**: create reusable command templates by category.
- **Settings / Workspace**: manage local/cloud mode, cloud workspaces, members, invites, backups, and Firebase sync.

## Tech Stack

- **Runtime**: Electron
- **Language**: JavaScript
- **Desktop UI**: HTML, CSS, vanilla renderer JavaScript
- **SSH/SFTP**: `ssh2`
- **Terminal UI**: `@xterm/xterm` and `@xterm/addon-fit`
- **Optional cloud backend**: Firebase Authentication and Cloud Firestore through Firebase REST APIs

## Requirements

Install these before running the project:

- Node.js LTS
- npm
- Git
- A server with SSH access if you want to test deployments
- Optional: Firebase project if you want cloud sync

Recommended:

- Windows 10/11 for the main packaged desktop target
- PowerShell or Windows Terminal
- A test VPS or local SSH server before using real production servers

## Quick Start

Clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/DeployerX.git
cd DeployerX
```

Install dependencies:

```bash
npm install
```

Start the desktop app:

```bash
npm start
```

The app opens as an Electron desktop window.

## First Run

When DeployerX opens for the first time, choose one of the setup modes:

- **Offline mode**: stores projects and templates locally on your machine.
- **Cloud mode**: uses Firebase Authentication and Cloud Firestore to sync projects, templates, teams, and invites.

If you do not need sync, choose offline mode. You can still manage servers, run SSH scripts, use templates, import/export data, and use file tools without Firebase.

## Local/Offline Mode

Offline mode is the simplest way to use DeployerX.

1. Start the app with `npm start`.
2. Choose offline/local mode during setup.
3. Create a project.
4. Add SSH details:
   - Host
   - Port
   - Username
   - Password or private key
   - Optional private key passphrase
5. Add deployment commands.
6. Connect through SSH or run the deployment script.

Local app data is stored in Electron's user data directory for DeployerX. You can use the app's import/export tools to move projects and templates between machines.

## Creating a Project

A project represents one deployable server/app target.

Typical project fields:

- Project name
- Server type/category
- SSH host
- SSH port, usually `22`
- SSH username
- Authentication type:
  - Password
  - Private key
- Deployment commands

Example deployment commands:

```bash
cd /var/www/my-app
git pull origin main
npm install
pm2 restart my-app
```

Use test servers first. DeployerX runs the commands you provide on the target server.

## Running Deployment Scripts

Inside a project, DeployerX can run saved commands over SSH.

The deployment flow is:

1. DeployerX connects to the configured SSH server.
2. If selected, DeployerX uploads a local file to a remote path.
3. DeployerX runs each command in order.
4. Output appears in the terminal/log area.
5. You can stop an active deployment from the app.

Good script examples:

```bash
cd /var/www/app
git pull
npm install
npm run migrate
pm2 restart app
```

```bash
cd /home/ubuntu/service
docker compose pull
docker compose up -d
docker system prune -f
```

## Interactive SSH Terminal

Each project includes an embedded SSH terminal powered by xterm.js.

Use it when you need to:

- Inspect the server manually.
- Run one-off commands.
- Check logs.
- Verify a deployment.
- Debug failed commands.

The terminal uses the project's SSH credentials.

## Command Templates

Templates let you save reusable command sets and apply them across projects.

Current template categories:

- Server
- Laravel
- Node.js
- Database
- Docker
- Maintenance
- Security
- Hosting
- Web Server
- Cache
- Control Panel
- PaaS

Template commands can include variables using this format:

```bash
cd {{app_path}}
git pull origin {{branch}}
pm2 restart {{process_name}}
```

Templates are useful for standardizing repeated workflows while still allowing project-specific values.

## FTP/SFTP File Tools

The app includes FTP-labeled file tools backed by the SSH/SFTP connection.

From the FTP view, you can:

- Connect to a project's server.
- List remote directories.
- Upload files or folders.
- Download files or folders.
- Create remote folders.
- Rename remote files/folders.
- Delete remote files/folders.
- Open remote entries locally after downloading them to a temporary location.

Because this uses the project's SSH connection, make sure the SSH user has the correct file permissions on the remote server.

## Import and Export

DeployerX supports data portability.

You can export:

- Selected projects
- Selected command templates
- Full account backup with projects and templates

You can import:

- Project JSON files
- Command template JSON files
- Full account backup JSON files

When imports contain duplicate names, the app asks whether to replace duplicates or skip them.

## Optional Firebase Cloud Sync

Cloud sync is optional. DeployerX works without Firebase in offline mode.

Use Firebase cloud mode if you want:

- Sign in with email/password.
- Optional Google login.
- Cloud workspaces.
- Team members and invites.
- Projects synced to Firestore.
- Templates synced to Firestore.
- Import local data into a cloud workspace.
- Encrypted SSH secrets before sync.

### How Cloud Security Works

Cloud mode stores project and template data in Cloud Firestore.

Sensitive SSH fields are encrypted before being saved to Firestore:

- SSH password
- SSH private key
- SSH private key passphrase

The encryption key is derived from the workspace/team passphrase using PBKDF2 and then used with AES-256-GCM. The passphrase is required to unlock synced SSH secrets.

Important:

- Do not lose the workspace passphrase.
- Firestore does not receive the plain SSH password/private key from DeployerX's cloud save path.
- Anyone with access to the app workspace still needs the passphrase to unlock encrypted SSH secrets.

## Firebase Setup

Follow these steps only if you want cloud sync.

### 1. Create a Firebase Project

1. Go to the Firebase Console.
2. Create a new Firebase project.
3. Choose a project name.
4. Google Analytics is optional for this app.

### 2. Create a Firebase Web App

1. Open your Firebase project.
2. Go to **Project settings**.
3. Under **Your apps**, create a **Web app**.
4. Copy the Firebase config values.

You need at least:

- `apiKey`
- `authDomain`
- `projectId`

### 3. Enable Firebase Authentication

1. In Firebase Console, open **Authentication**.
2. Click **Get started**.
3. Open **Sign-in method**.
4. Enable **Email/Password**.

Email/password login is enough for cloud mode.

### 4. Optional: Enable Google Login

Google login is optional.

To use it:

1. In Firebase Authentication, enable **Google** as a sign-in provider.
2. In Google Cloud Console, configure an OAuth client.
3. Prefer a **Desktop app** OAuth client for packaged desktop usage.
4. Add the client ID to `firebase.config.json` as `googleClientId`.
5. If you use a Web OAuth client instead, also provide `googleClientSecret`.
6. Keep the redirect URI as:

```text
http://127.0.0.1:42813/oauth/google
```

The example config already includes this redirect URI.

### 5. Enable Cloud Firestore

1. In Firebase Console, open **Firestore Database**.
2. Click **Create database**.
3. Choose production mode.
4. Select a region close to your users.
5. Finish setup.

### 6. Deploy Firestore Rules

This repository includes Firestore rules in:

```text
firestore.rules
```

Install the Firebase CLI if needed:

```bash
npm install -g firebase-tools
```

Login:

```bash
firebase login
```

Select or create Firebase CLI project configuration:

```bash
firebase init firestore
```

When asked for the rules file, use:

```text
firestore.rules
```

Deploy the rules:

```bash
firebase deploy --only firestore:rules
```

If Firestore rules are not deployed, cloud mode may show permission errors such as missing or insufficient permissions.

### 7. Create `firebase.config.json`

Copy the example file:

```bash
copy firebase.config.example.json firebase.config.json
```

On macOS/Linux:

```bash
cp firebase.config.example.json firebase.config.json
```

Edit `firebase.config.json`:

```json
{
  "apiKey": "YOUR_FIREBASE_WEB_API_KEY",
  "authDomain": "YOUR_PROJECT.firebaseapp.com",
  "projectId": "YOUR_PROJECT_ID",
  "googleClientId": "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  "googleClientSecret": "",
  "googleRedirectUri": "http://127.0.0.1:42813/oauth/google"
}
```

For email/password cloud login, only these are required:

```json
{
  "apiKey": "YOUR_FIREBASE_WEB_API_KEY",
  "authDomain": "YOUR_PROJECT.firebaseapp.com",
  "projectId": "YOUR_PROJECT_ID"
}
```

Do not commit your real `firebase.config.json`. It is already ignored by `.gitignore`.

### 8. Alternative: Use Environment Variables

Instead of `firebase.config.json`, DeployerX can read Firebase settings from environment variables:

```bash
FIREBASE_API_KEY=your-api-key
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_GOOGLE_CLIENT_ID=your-google-client-id
FIREBASE_GOOGLE_CLIENT_SECRET=your-google-client-secret
FIREBASE_GOOGLE_REDIRECT_URI=http://127.0.0.1:42813/oauth/google
```

Only `FIREBASE_API_KEY` and `FIREBASE_PROJECT_ID` are required for the app to detect an environment-based Firebase config.

### 9. Start DeployerX in Cloud Mode

After Firebase is configured:

1. Start the app with `npm start`.
2. Choose cloud mode.
3. Register or log in.
4. Verify email if using email/password.
5. Create a workspace.
6. Set a workspace passphrase.
7. Add or import projects/templates.
8. Use **Import local data to cloud** if you already created local data.

## Firestore Data Model

Cloud mode uses these Firestore areas:

```text
users/{uid}
teams/{teamId}
teams/{teamId}/members/{uid}
teams/{teamId}/invites/{inviteId}
teams/{teamId}/projects/{projectId}
teams/{teamId}/templates/{templateId}
```

The included `firestore.rules` file restricts access so users can only access their own profile and teams where they are members.

## Firebase Troubleshooting

### Firebase Web config is missing

Add `firebase.config.json`, select a Firebase config from the app, or provide environment variables.

### Cloud Firestore is not enabled

Open Firebase Console and create a Firestore database for the project.

### Missing or insufficient permissions

Deploy the included Firestore rules:

```bash
firebase deploy --only firestore:rules
```

### Google rejected the token exchange

For desktop usage, prefer a Google OAuth Desktop client ID. If using a Web OAuth client, include `googleClientSecret` in `firebase.config.json`.

### Google login redirect fails

Confirm the redirect URI matches:

```text
http://127.0.0.1:42813/oauth/google
```

## Packaging for Windows

The project includes a Windows packaging script in `package.json`:

```bash
npm run package:win
```

This creates Windows installer and portable artifacts in the `dist` folder using Electron Builder.

There is also a helper batch file:

```text
build-exe.bat
```

The batch file checks for Node/npm, installs dependencies if needed, and creates the Windows installer/portable executable.

## Project Structure

```text
DeployerX/
  assets/
    deployerx-logo.ico
    deployerx-logo.png
  scripts/
  src/
    main.js
    preload.js
    renderer/
      index.html
      renderer.js
      styles.css
  firebase.config.example.json
  firestore.rules
  package.json
  README.md
```

## Important Files

- `src/main.js`: Electron main process, SSH/SFTP, Firebase REST calls, local/cloud storage, deployment execution.
- `src/preload.js`: safe renderer API exposed through Electron context bridge.
- `src/renderer/index.html`: app UI markup.
- `src/renderer/renderer.js`: renderer-side app behavior.
- `src/renderer/styles.css`: app styling.
- `firebase.config.example.json`: sample Firebase web config.
- `firestore.rules`: Firestore access rules for cloud sync.
- `package.json`: app metadata, dependencies, and npm scripts.

## Development Notes

This app intentionally keeps the stack simple:

- No frontend framework is required.
- The renderer is plain HTML/CSS/JavaScript.
- Electron's context isolation is enabled.
- The renderer talks to the main process through `src/preload.js`.
- Local data is stored through Electron app data files.
- Cloud data is stored in Firebase only when cloud mode is enabled.

When adding features, prefer:

- Small focused changes.
- Clear IPC APIs in `preload.js`.
- Keeping secrets out of renderer state when possible.
- Preserving offline mode.
- Preserving import/export compatibility.
- Avoiding paid or locked cloud assumptions.

## Security Notes

DeployerX handles powerful server credentials and deployment commands. Use it carefully.

- Test commands on non-production servers first.
- Use least-privilege SSH users.
- Prefer SSH keys over passwords when possible.
- Keep private keys secure.
- Do not commit real Firebase config files.
- Do not commit exported project/account backup files if they contain secrets.
- Review scripts before running them.
- Use cloud workspaces only with people you trust.
- Store the workspace passphrase securely.

## Contributing

Contributions are welcome.

Good first contribution areas:

- Improve documentation.
- Add screenshots.
- Improve onboarding copy.
- Add tests around import/export formats.
- Improve Firebase setup validation.
- Improve accessibility.
- Add more template examples.
- Improve packaging for other platforms.

Suggested workflow:

1. Fork the repository.
2. Create a feature branch.
3. Make focused changes.
4. Test the app locally with `npm start`.
5. Open a pull request with a clear description.

## Roadmap Ideas

Possible future improvements:

- More built-in deployment templates.
- Server health checks.
- Script history.
- Per-command success/failure summaries.
- Safer dry-run mode.
- Environment variable management.
- Better team audit history.
- Cross-platform packaging.
- Optional encrypted local vault.
- Plugin hooks for custom deployment flows.

## License

This project is intended to be open source.

## Maintainer

Created by Manish K.

Community contributions, issues, and improvement ideas are welcome.
