# Installing Chorus on Windows

Chorus drives the `claude` and `codex` CLIs you already have. It does not bundle
them, and it will not install them for you — so most of what follows is about
getting those two working first, because a Chorus that cannot find them looks
broken in a way that has nothing to do with Chorus.

> **Status: installed and running on Windows since 2026-09-21, and still
> unsigned.** The installer has been run, the app starts, and `codex` and
> `claude` both join a conversation and take a turn — verified by finding a
> `claude.exe` whose parent process is `Chorus.exe`. Two defects had to be fixed
> to get there and both are described under Troubleshooting below, because a
> build from before that date still has them.
>
> What has **still** not been exercised: uninstall, reinstall, and whether your
> conversations survive a version change. `docs/windows-test-brief.md` is the
> brief for that, and `docs/windows-deploy.md` is how a build gets onto a
> machine.

## What is supported

|               |                                                                 |
| ------------- | --------------------------------------------------------------- |
| Windows       | 10 and 11, 64-bit                                               |
| Architecture  | x64 only — ARM64 waits for native hardware to verify it on      |
| Install scope | Per-machine. The installer asks for administrator; Chorus does not |
| Shortcuts     | Start Menu. No desktop shortcut unless you ask for one          |
| Updates       | Download and run the new installer over the old one             |
| WSL           | Not supported. Agents run as native Windows processes           |

## Before you install

### Codex

```powershell
npm install -g @openai/codex
codex --version
```

### Claude Code

```powershell
npm install -g @anthropic-ai/claude-code
claude --version
```

**Claude Code on native Windows needs Git for Windows**, for the POSIX tools it
shells out to. Install it from <https://git-scm.com/download/win> before running
`claude` for the first time. Without it, `claude` starts and then fails partway
through a turn with an error that names a missing binary rather than the missing
dependency.

Authenticate both by running them once in a terminal and following the prompts.
Chorus inherits whatever credentials they store; it never asks for them itself
and has nowhere to put them.

### DeepSeek

Nothing to install. DeepSeek runs on the same `claude` binary, pointed at its
own endpoint, so if `claude` works DeepSeek's half of the problem is already
solved. What it needs is an API key, added in **Settings** — and the key is
stored per machine, so a machine you have just installed on has none and
DeepSeek refuses with _"DeepSeek needs an API key"_ until you add one. That is
the expected message on a fresh install rather than a fault.

### Both CLIs must be on PATH

`npm install -g` writes to `%APPDATA%\npm`, which npm adds to PATH at install
time. If you installed Node through a version manager, or PATH predates the npm
install, Chorus may not find them. It looks in `%APPDATA%\npm` explicitly for
this reason, but the reliable check is:

```powershell
where.exe codex
where.exe claude
```

If those print nothing, neither will Chorus.

## Installing

1. Download `Chorus-<version>-windows-x64-setup.exe` from the
   [releases page](https://github.com/mohammadtmohsen/chorus/releases). The
   `.sha256` beside it is the checksum for that exact file.
2. **Expect a SmartScreen warning.** Choose "More info" then "Run anyway". This
   is not a sign that anything is wrong — see below.
3. **Approve the administrator prompt.** Chorus installs per-machine, into
   `C:\Program Files\Chorus`, so the installer needs it.
4. Launch from the Start Menu.

Chorus itself never needs administrator rights. It runs `asInvoker` and does
everything under your own profile — elevating the installer says nothing about
what the app runs as afterwards.

**Per-machine is deliberate, and it is about upgrades rather than about
privilege.** A per-user installer landing on a machine that already had a
per-machine Chorus produced a second copy under `%LOCALAPPDATA%\Programs`: two
Start Menu entries with one name, both reporting the same version, and no way to
tell which one you had just launched. One scope means an upgrade replaces rather
than joins.

**Close Chorus before upgrading if a turn is running.** The installer closes it
for you, which is convenient and is also a decision made on your behalf — an
agent mid-turn is killed. Nothing in your history is lost; the event log is
append-only.

### About the SmartScreen warning

**This installer is not signed at all**, so the warning is expected rather than
surprising. It is worth understanding what a signature would and would not buy.

A valid signature and a good reputation are different things. SmartScreen scores
by how many people have downloaded a given signed binary, so even a correctly
signed build from a newly issued certificate is warned about — for weeks,
sometimes months. Signing is on the roadmap; it will make the warning
_eventually_ go away, not immediately.

To check the signature yourself rather than trusting the dialog:

```powershell
Get-AuthenticodeSignature .\Chorus-<version>-windows-x64-setup.exe |
  Format-List Status, SignerCertificate
```

`Status` must be `Valid`, and the certificate's subject must match the publisher
named on the release page. Verify the checksum too:

```powershell
Get-FileHash .\Chorus-<version>-windows-x64-setup.exe -Algorithm SHA256
```

against the `.sha256` file published beside the installer.

## Where things go

These are the paths as observed on a real install, not as inferred from the
config — the table here previously named `%APPDATA%\Chorus`, which does not
exist.

|             |                                        |
| ----------- | -------------------------------------- |
| Application | `C:\Program Files\Chorus`              |
| Your data   | `%APPDATA%\@chorus\desktop`            |
| Event log   | `%APPDATA%\@chorus\desktop\chorus.v2.db` |
| Logs        | `%APPDATA%\@chorus\desktop\logs`       |

**The event log is every conversation you have had.** It is the source of truth
and it is append-only. Uninstalling deliberately leaves `%APPDATA%\@chorus`
alone — removing it is a decision an uninstaller should not make for you. To
remove your data, delete that folder by hand after uninstalling.

`chorus.log` in that `logs` folder is the first place to look when something
does not work. It is one JSON object per line, and its timestamps are epoch
milliseconds — worth converting before you conclude anything, because the
transcript replays old events and a stale error reads exactly like a live one.

Upgrading installs over the previous version and does not touch it.

## VS Code integration

Optional. It gives Chorus your current file and selection as context.

Chorus ships the extension and installs it through the `code` CLI, so `code`
must be on PATH:

```powershell
where.exe code
```

If it prints nothing, open VS Code, run **Shell Command: Install 'code' command
in PATH** from the command palette, and restart Chorus. Chorus also looks in
VS Code's default install location, so this is a fallback rather than a
requirement.

## Troubleshooting

**"Could not find the claude CLI" on a build from before 2026-09-21** — fixed,
and worth naming because the symptom pointed away from the cause. Claude Code
2.x installed with `npm -g` writes a `claude.cmd` that runs a native
`claude.exe`, not the `cli.js` earlier versions ran. Chorus only knew how to
read the older shape, so it found the shim, could not read it, and passed the
CLI nothing — while reporting itself ready, because the version probe goes
through `cmd.exe` where the shim works fine. `claude` and `deepseek` both joined
a conversation and then failed on their first turn. Update, or the only fix is
to have `claude.exe` somewhere Chorus looks directly.

**The editor shows `[UriError]` instead of opening, on a build from before
2026-09-21** — also fixed. A `vscode-remote` URI refuses a path that does not
begin with a slash, and `C:\Users\you\project` does not. The workbench threw out
of `prepareWorkbench` and no editor appeared at all, only the stack trace.
Updating is the fix. Expect that project's editor layout and its workspace-trust
answer to reset once afterwards, because the corrected path is also what keys
the workbench's storage.

**"Could not find the codex CLI" / "the claude CLI"** — `where.exe` the one it
names. If the CLI is plainly there and Chorus still cannot see it, the log in
`%APPDATA%\@chorus\desktop\logs` names the path it tried, and that is the thing
to report.

**A terminal will not open** — Chorus uses `%COMSPEC%`, falling back to
`cmd.exe`. Check that `%COMSPEC%` points at a file that exists:
`Test-Path $env:COMSPEC`.

**The VS Code pill says "not running"** — the editor bridge is a named pipe
(`\\.\pipe\chorus-ide-<pid>`) advertised through a descriptor in
`%TEMP%\chorus-ide`. Check that the folder exists and holds a `.json` per
running Chorus. If it does and the pill is still empty, the extension is not
installed or is a different protocol version — Settings shows both.

**An agent's own terminal behaves differently from Chorus's** — expected.
`Ctrl+J` opens a real shell that is yours; the agents run headless over stdio
and never see a terminal.

**A shortcut does nothing** — Chorus uses Ctrl on Windows where the macOS build
uses Command, so every shortcut documented with `⌘` is `Ctrl` here. `Ctrl+Shift+J`
opens the global terminal, `Ctrl+Shift+\`` a new one in the current panel.

## Known gaps on Windows

These are real and deliberate, not oversights:

- **The orphan-process backstop does not run.** On macOS Chorus reaps agent
  processes left by a crash. The Windows strategy has not been written, because
  the Unix one relies on `PPID 1` and `SIGKILL`, neither of which exists here.
  A crash may leave a `codex` or `claude` process behind; Task Manager will show
  it.
- **A terminal never reports as busy.** The kill confirmation cannot warn you
  that a build is running, because node-pty does not expose the foreground
  process on Windows. It asks before closing regardless.
- **The editor bridge relies on its handshake token alone.** On macOS the socket
  is also `0600`. Node offers no way to set a security descriptor on a named
  pipe, so on Windows the token in the descriptor file is the only guard.
- **Trusted mode is newer here.** The universal denies cover cmd and PowerShell
  recursive deletion, force-push and history rewriting. They have unit coverage
  and have not been exercised against a real Windows agent.
