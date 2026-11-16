# GLMPS 2.0

**Watch your agents. Catch the misses.**

**A local control plane for your coding agents.**

<img width="1226" height="1148" alt="The GLMPS 2.0 Surface lens: live sessions on the globe above the fleet board" src="https://github.com/user-attachments/assets/8add446a-8686-4d33-bd4b-e2450f08425a" />

https://github.com/user-attachments/assets/2b6200ed-39b8-4ce7-b981-41bd609c6ea0

<p align="center">A 60-second tour of the four lenses: Surface, Work, Evolution and Knowledge. <a href="docs/media/glmps-2.0-tour.mp4">Download the tour</a>.</p>

GLMPS 2.0 watches the coding-agent sessions on your computer (Claude Code, Antigravity, Gemini CLI, Codex and others) by reading the session logs those tools already write. It never proxies them or sits between an agent and its model. It shows what each session is touching, doing and learning, runs the work itself from a board (a queue runner launches cards, a merge queue tests and lands their pull requests), and turns the moments an agent should have used a skill, subagent or hook into guards you approve.

- Runs on your computer and listens on `127.0.0.1` (this computer only) by default.
- One desktop app: the dashboard and Slack side by side, with its own copy of Node and the GLMPS server inside.
- MIT licensed.

## What a control plane for agents is

Infrastructure tools split the system in two. The data plane does the work. The control plane decides what work runs, watches it, checks the result against what was wanted and enforces the rules. It does not do the work itself.

GLMPS applies that split to coding agents. The agents are the data plane: Claude Code, Antigravity, Codex and the rest run in their own processes, call their own models and edit your repositories. GLMPS is the control plane beside them, running on the same computer. It does five things:

- **Watch.** Each supported tool has an adapter that reads the session logs the tool already writes, so a session looks the same in the dashboard whichever tool produced it: the files it touched, the commands it ran, the skills, subagents and memory it used, and its git activity. Watching is read-only.
- **Dispatch.** Work is a card on the board, filed by you in the dashboard or from a Slack thread. The queue runner launches the top queued card as an agent session in its own git worktree and branch, so parallel cards never share files.
- **Verify.** A card's work is checked by something other than the session that did it. The session records a gate verdict (PASS, CONCERNS, FAIL or WAIVED) against the card's acceptance criteria, and the merge queue runs the affected tests on the pull request merged with its base before it merges. Background jobs follow the same rule: every scheduled job in the kernel is a registered loop with a maker, a separate checker, a ceiling on attempts and time, and an outcome that is never a silent skip. Every promise the system makes, such as "this loop runs every hour" or "this gate gets an independent verdict", is an obligation with a due time, and a missed one becomes an alert.
- **Govern.** For Claude Code, GLMPS installs hooks through Claude Code's own hook settings (with a backup, and `--uninstall` removes exactly what it added). They give you stop and approval gates on a running session, a plan gate that blocks a large change until a spec exists, a guard against writes into a live install folder you name, and a done gate that keeps a session from stopping while its checks fail. Cards from outside are scanned for injected instructions at intake and quarantined until you release them. Other tools are watched but not steered.
- **Learn.** When a session should have reached for a skill, subagent or hook and did not, GLMPS records the miss. A miss that recurs becomes a proposed guard: a rule added to the agents' global instructions. It lands only on your approval, or through an auto-approval path limited to reviewed templates with a daily cap and a probation period that can revert it.

"Local" means all of this runs on your computer: the kernel is one Node process on `127.0.0.1:8123`, and its state is a folder in your home directory. Nothing is hosted.

### What it is not

- **Not a framework.** You do not import GLMPS and build on it. It is an application you install and point at your repositories and agent tools.
- **Not an in-process orchestrator.** Tools like LangGraph and CrewAI sit inside the model call graph and route each step. GLMPS works one level up: it hands whole cards to agent tools that run on their own, then checks what comes back.
- **Not an operating system.** Its core is called the kernel and it has OS-like parts (scheduled loops, obligations, permission gates, shared memory), but it does not own the agents' processes or runtimes. It supervises tools that live outside it.

## Install

1. Download `GLMPS.2.0.Setup.<version>.exe` (for example `GLMPS.2.0.Setup.2.0.0.exe`) from the [latest release](https://github.com/wolfeb-dev/glmps/releases/latest) and run it (Windows, 64-bit). The release notes give the file's SHA-256. The installer is not code-signed yet, so Windows SmartScreen may warn on the first run: choose **More info**, then **Run anyway**. It installs for your user only, so it needs no administrator rights. It shows the license, lets you choose the install folder, adds a desktop and Start menu shortcut named **GLMPS 2.0** and starts the app when it finishes.
2. On first start the app runs the GLMPS server (the kernel) itself, opens the dashboard and opens the **setup wizard** in its own window. The same dashboard is at http://127.0.0.1:8123 in any browser on this computer.
3. The setup wizard takes the computer to a working GLMPS, one step at a time, and shows a checked status for each. Every step can be skipped and the wizard can be run again any time from the tray menu (**Run setup wizard**):
   - **Tools:** checks Node.js, Git, Claude Code, the GitHub CLI and graphify, and installs what is missing or updates what is out of date through winget (graphify through uv, which it installs first). Windows may ask you to allow an install.
   - **Claude account:** opens the Claude Code sign-in in your browser, and skips it if you are already signed in.
   - **GitHub:** signs the GitHub CLI in with the permissions GLMPS needs (`repo`, `workflow`, `read:org`) and sets git to use it. Already signed in without one of them, it asks GitHub for just the missing ones.
   - **Slack:** **Create the app** opens Slack with the GLMPS bot app (Riker) already filled in: its permissions, Socket Mode and events. Install it to your workspace, paste the bot token (`xoxb-`) and an app-level token (`xapp-`, scope `connections:write`) and your Slack email. The wizard checks the tokens with Slack, saves them to the local credential store, creates the GLMPS channels, adds you to them and allows you to command the agents, then restarts GLMPS so Slack connects.
   - **Claude Code helper:** installs the GLMPS hooks and status line into your Claude Code settings (it keeps a backup), so your sessions show up in the dashboard.
   - **Repositories:** finds the git repositories under a folder you pick and writes your profile (`glmps.profile.json` in `%APPDATA%\GLMPS2`).
   - **Ready check:** shows each of the above as passing or needing attention. **Finish** turns on **Run at startup** unless you clear the box, because GLMPS's runner, merge queue and Slack stop while the app is closed.

   A source checkout can still use the console wizard in `scripts/setup/glmps-setup.ps1`.

A fresh install opens with the user guide already built (see [The wiki](#the-wiki)), the code graph of GLMPS itself, and a small set of starter memories and guards. Each is copied in only when your state has none (or, for the wiki and the graph, an older copy), so an install never overwrites what you already have.

## Using it

The top bar has four lenses:

- **Surface:** live and recent sessions across every tool, with what each one is touching and anything that needs your attention.
- **Work:** the board, session history, QA trends and cost.
- **Evolution:** the learning loop: capabilities, the impact ledger, experiments and the loops that run in the background.
- **Knowledge:** the wiki, the architecture graph and decisions.

GLMPS reads sessions from Claude Code, Antigravity, the Antigravity CLI, Gemini CLI, Codex CLI, GitHub Copilot (CLI and Chat), Cursor CLI, Cline and Roo, OpenCode, Factory Droid, Grok, Hermes, OpenClaw and Pi.

Closing the window keeps GLMPS running in the tray. When the app runs the kernel itself, **Quit** from the tray (or signing out of Windows) stops it, and the nightly run, Slack approvals, deadlines and the merge queue wait until the app runs again. Turn on **Run at startup** in the tray menu to keep it running.

## Where state lives

| What | Where |
| --- | --- |
| GLMPS state (session index, board, learning queue, memory, wiki builds, graphs) | `.glmps2` in your home folder (`%USERPROFILE%\.glmps2`) |
| Kernel log | `logs\kernel.log` inside the state folder (tray menu: **Open logs folder**) |
| App settings and the kernel config | `%APPDATA%\GLMPS2` (the kernel reads `kernel\config.json` there) |
| The program itself | the install folder you chose |

If `.glmps2` does not exist in your home folder when GLMPS starts, it uses `.glmps` there instead, the folder name earlier versions used. The kernel config starts as a copy of `config.example.json` with the port filled in; change only the keys you need.

## Upgrade

Run the newer GLMPS 2.0 installer over the old one. Your state folder and app settings are left in place: the installer replaces only the program. Uninstalling does not delete your data either; remove the `.glmps2` folder yourself if you want a clean start.

## The wiki

The user guide, admin guide and concept pages are in the dashboard under **Knowledge**, on the **Wiki** tab. The installer carries a prebuilt copy, so it is there on first start before any model has run. A wiki your copy builds later is kept; a newer installer replaces only an older one.

## Running from source (contributors)

You need Node.js 22.5 or newer and Git. The server, dashboard, hooks and scripts take no npm dependencies.

```bash
git clone <repository-url> glmps
cd glmps
npm start          # serves the dashboard on http://127.0.0.1:8123
npm run setup      # installs the GLMPS hooks and statusline tap into your Claude Code config
npm test           # the node:test suite
```

A source checkout reads the same state folder and `config.json` at the repository root, so stop the installed app before you start a second server on port 8123, or set `GLMPS_STATE_DIR` and a different `port` in `config.json`. The dashboard under `web/` is served from disk on every request, so UI edits show on refresh; changes under `server/` or `taps/` need a restart.

The desktop app lives in `apps/shell` (Electron). `npm ci && npm run dist` there builds the installer, with the kernel taken from a tested commit, into `apps/shell/dist`. `node scripts/release-installer.mjs` then shows the GitHub release it would make from that build (tag `v<version>`, the file and its SHA-256), and `--apply` publishes it (`--replace` uploads over an existing release of the same version, `--repo` picks another repository).

## License

MIT. See [LICENSE](LICENSE).
