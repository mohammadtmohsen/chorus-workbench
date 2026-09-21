# Building a Windows installer from this Mac, and putting it on a machine

Written 2026-09-21, from the first time it was done end to end. Everything here
was observed rather than reasoned; where something is still unproven it says so.

The short version, for when you already know why:

```bash
pnpm --filter @chorus/desktop run build
pnpm --filter @chorus/desktop exec electron-builder --config electron-builder.yml --win --x64
shasum -a 256 apps/desktop/release/Chorus-<version>-windows-x64-setup.exe
scp apps/desktop/release/Chorus-<version>-windows-x64-setup.exe officepc:Downloads/
ssh officepc "(Get-FileHash 'C:\Users\user\Downloads\Chorus-<version>-windows-x64-setup.exe' -Algorithm SHA256).Hash"
ssh officepc "\$p = Start-Process -FilePath 'C:\Users\user\Downloads\Chorus-<version>-windows-x64-setup.exe' -ArgumentList '/S' -Wait -PassThru; \$p.ExitCode"
```

The rest of this page is why each of those lines is the shape it is.

## The cross-build needs no toolchain, and that is worth knowing before you avoid it

The instinct is that packaging a Windows app on macOS means wine, a compiler, or
both. It means neither here, and the reason is specific rather than lucky.

`better-sqlite3` ships **every** platform's binary inside its own package —
`prebuilds/win32-x64.node` is sitting in `node_modules` on this Mac right now —
and `node-pty` does the same, with a `prebuilds/win32-x64` directory beside the
darwin ones. `electron-builder.yml` sets `npmRebuild: false`, so electron-builder
copies those rather than compiling anything. A macOS host therefore has, on disk,
everything a Windows bundle needs.

NSIS itself is downloaded on demand — `nsis-3.0.4.1.7z`, `nsis-resources-3.4.1.7z`
and a `7zip-darwin-arm64.tar.gz` — and runs natively. The first build here took
about four minutes, most of it the remote extension host.

**What this does not prove.** The bundle is assembled correctly and the installer
runs; nothing about a cross-built binary has been differentially tested against
one built on a Windows runner. If a difference ever appears, that is the first
thing to suspect and it has never been checked.

## `pnpm run … -- --win` silently builds the wrong thing

The first attempt used:

```bash
pnpm --filter @chorus/desktop run package -- --win --x64
```

and produced `Chorus-0.20.0-arm64.dmg`. The flags did not reach electron-builder;
it fell through to the host platform and built macOS. Nothing failed — exit code
0, a real artifact, the wrong operating system.

**Read the log rather than the exit code.** The line that settles it is:

```
• packaging       platform=win32 arch=x64 electron=43.2.0 appOutDir=release/win-unpacked
```

If that says `platform=darwin`, stop. Invoke electron-builder directly through
`pnpm exec` instead of through the `package` script, which is what the command at
the top of this page does.

## The remote extension host is staged per architecture, and it is a separate download

`beforePack` runs `build/stage-reh.cjs`, which is handed the target architecture
and picks the matching archive out of `build/workbench-runtime.json`. A Windows
build fetches `vscodium-reh-win32-x64-<release>.tar.gz`, about 76 MB, and it is
cached in the same place the running app uses — so the second build of the day
does not download it again.

Check it landed:

```
• bundling workbench server  win32-x64 vscodium-reh-win32-x64-1.121.03429.tar.gz (75712669 B)
```

A build that says `darwin-arm64` there has staged the wrong server into a Windows
app, and the failure would surface on a stranger's first launch rather than here.

`CHORUS_SKIP_REH_BUNDLE=1` packs without it, producing a smaller installer that
downloads the server on first run. Useful for a quick local test, wrong for
anything you hand to someone.

## Install scope: per-machine, and the trap that decided it

`nsis.perMachine` is `true`. It was `false`, and the failure that changed it is
worth keeping because it is silent.

A machine that already carried a **per-machine** Chorus at `C:\Program Files\Chorus`
would, on a per-user installer, gain a **second** Chorus under
`%LOCALAPPDATA%\Programs\Chorus`. Two Start Menu entries with one name, both
reporting the same version, nothing to tell the running one from the new one, and
the one you launch decided by which shortcut you happen to click.

So: **before installing, look at what is already there.**

```powershell
Test-Path 'C:\Program Files\Chorus\Chorus.exe'
Test-Path "$env:LOCALAPPDATA\Programs\Chorus"
(Get-Process Chorus).Count
```

The cost of per-machine is a UAC prompt. It is paid by the installer, not by the
app — `requestedExecutionLevel` stays `asInvoker`, so Chorus still runs as you.

## Delivering it over SSH

`scp` to the `officepc` alias works directly; the alias carries port 2222, so do
not pass a host and port by hand. 184 MB over the tailnet took under a minute.

**Verify the copy by hash, on both sides.** A truncated transfer produces an
installer that fails in a way that looks like a bad build.

The silent install, from a session that is already elevated:

```powershell
$p = Start-Process -FilePath 'C:\Users\user\Downloads\Chorus-<version>-windows-x64-setup.exe' `
  -ArgumentList '/S' -Wait -PassThru
$p.ExitCode
```

`-Wait -PassThru` is the whole point: without it `Start-Process` returns
immediately and the SSH command reports success while NSIS is still copying.

The installer closes a running Chorus itself. That is convenient and it is also a
decision being made on someone's behalf — if a turn is in flight it dies. The
event log survives, because it is append-only SQLite and
`deleteAppDataOnUninstall` is `false`.

## Verify the install by hashing `app.asar`, not `Chorus.exe`

`Chorus.exe` is the Electron binary and is byte-identical across builds of the
same Electron version, so hashing it proves nothing about your code. The file
timestamp proves less than it looks like it does, because NSIS preserves times
from the build machine.

The code lives in `resources\app.asar`:

```bash
shasum -a 256 apps/desktop/release/win-unpacked/resources/app.asar
```

```powershell
(Get-FileHash 'C:\Program Files\Chorus\resources\app.asar' -Algorithm SHA256).Hash
```

Those two matching is the only evidence that the machine is running what you
built. It is what caught a question that would otherwise have been unanswerable —
whether a failure showing on screen came from the new build or from the old one
still running.

## You cannot launch it from here

The SSH session on that box has no interactive desktop, so starting an Electron
app over it does not put a window in front of anyone. Launching, and therefore
every claim about whether the app actually works, needs RustDesk.

What SSH **can** answer, and what settled both defects below:

```powershell
Get-Content "$env:APPDATA\@chorus\desktop\logs\chorus.log" | Select-Object -Last 20
Get-CimInstance Win32_Process -Filter "Name='claude.exe'" |
  ForEach-Object { '{0} parent={1}' -f $_.ExecutablePath, $_.ParentProcessId }
```

A `claude.exe` whose parent is `Chorus.exe` is proof an agent started. Timestamps
in the log are epoch milliseconds; convert them before concluding anything, because
a transcript replays old events and a stale error reads exactly like a live one.
That mistake was made here and cost a round trip.

## Two defects this exercise found, and what they generalise to

**`claude` resolved to a shim nobody could read.** Claude Code 2.x installed with
`npm -g` writes a `claude.cmd` whose target is a native `claude.exe`, not the
`cli.js` the shim used to run. `parseShimTarget` demanded a `.js`, answered null,
and the SDK was handed nothing — while `health()` reported ready, because it
probes through `cmd.exe` where the shim works perfectly. Both `claude` and
`deepseek` would have joined a conversation and died at the first turn.

The lesson is the one the Adapters section of `CLAUDE.md` already states one level
up: **read the real thing.** The parser was written from cmd-shim's documentation
and had never been compared against a shim off a real `npm install`. Ten seconds
of `Get-Content claude.cmd` over SSH was the whole diagnosis.

**The workbench never started, on a URI.** A URI carrying an authority may not
have a path that fails to begin with a slash, and `C:\Users\me\project` does not.
Every absolute macOS path already does, which is why this survived: the conversion
existed but was gated on `host !== LOCAL_HOST`, so the ordinary local-Windows case
was the only one it skipped. The rule now lives once, as `remotePath` in
`shared/workbench-ipc.ts`.

The lesson is narrower and worth stating plainly: **a platform conditional written
for the remote case is not coverage of the platform.** The test that existed
asserted the remote arm and passed throughout.

## Version discipline

The build described here reports `0.20.0` and is **not** the published `0.20.0` —
it is `main` with commits on top. That was a deliberate choice for one machine and
it does not survive being handed to a second person: two different builds
answering to one version number is an hour of confusion later, and neither the app
nor the installer can tell them apart.

If it is going anywhere beyond one box, bump the version and write the CHANGELOG
entry. The release procedure in `CLAUDE.md` is the path, and the pipeline refuses
to build when the two `package.json` files and the tag disagree — which is that
same rule, enforced.

## What is still unproven

- **The installer's own behaviour beyond a first install.** Upgrade over an
  existing per-machine install has been done once. Uninstall, reinstall, and
  whether the event log survives a version change have not been tested.
  `docs/windows-test-brief.md` is the brief for that.
- **ARM64.** No Windows-on-ARM machine has run any of this.
- **A cross-built bundle against a runner-built one.** See the first section.
