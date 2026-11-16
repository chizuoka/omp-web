# Installing this omp-web fork globally

Two verified paths:

- [Windows / bun](#windows--bun) (the rest of this document, bun 1.4.4)
- [Linux / WSL / npm](#linux--wsl--npm) (short, no rebuild needed)

The tarball (`omp-web-<version>.tgz`) is a **build artifact, not a source
file**. Do not commit it: it is ~4.8 MB, regenerable with `bun pm pack` /
`npm pack`, and is the only thing the installs below consume. Keep it outside
the repo (this machine keeps it in `D:/GitRepos/omp/`, next to the clone)
because the Windows bun global manifest records its absolute path.

## Linux / WSL / npm

Verified on WSL2 (Node 22, npm global prefix `~/.local`). No `.env` files were
involved on this machine; if you use `OMP_WEB_ALLOWED_HOSTS`, put it in the
installed directory's `.env` after the install (step 4).

1. **Get a tarball.** Reuse an existing one if the sources have not changed
   (the `.next` bundle inside is platform-independent JS), otherwise build and
   pack on a machine whose `node_modules` matches the build host:

   ```bash
   cd <repo>/omp-web
   npm ci && npm run build      # or: bun install && bun run build
   npm pack --pack-destination <somewhere-outside-the-repo>
   ```

   Do not run `npm ci` / `bun install` over a `node_modules` that was installed
   on Windows (it contains `.exe` shims and platform binaries); on WSL with the
   repo on `/mnt/d`, that would clobber the Windows install. Reuse the tarball
   instead, or build from a separate Linux clone.

2. **Install it globally** (this replaces upstream `omp-web` in place; npm
   copies the tarball, so the file can be moved afterwards):

   ```bash
   cd ~
   npm install -g /path/to/omp-web-0.5.1.tgz
   ```

   Takes a few minutes (~200 packages). `npm` runs the dependency lifecycle
   scripts itself, so there is no `bun pm trust` step.

3. **Verify:**

   ```bash
   D=$(npm root -g)/omp-web
   cat "$D/.next/BUILD_ID"
   grep -rlE "data-minimap-node-index|minimap-preview-lock|chatMinimap.locateAssistant" "$D/.next/static"
   which -a omp-web             # first hit must be the npm/bun-installed launcher you expect
   ```

   Smoke test (use a scratch port, and stop it by PID — `pkill -f omp-web`
   patterns can match your own shell):

   ```bash
   omp-web -p 30156 & PID=$!
   sleep 8
   curl -s http://127.0.0.1:30156/ | grep -o "$(cat "$D/.next/BUILD_ID")"
   kill $PID; pgrep -af 'next start.*30156'   # kill any leftover child by PID
   ```

4. **Optional `.env`:** create `$D/.env` (and `.env.local`) with e.g.
   `OMP_WEB_ALLOWED_HOSTS=host1,host2`. They are not part of the tarball, so
   re-create them after every reinstall.

`npm update -g omp-web` (or `bun upgrade omp-web`) pulls upstream's `0.5.1`
from the registry and overwrites the fork — reinstall from the tarball.

## Windows / bun

Verified end-to-end on Windows (bun 1.4.4) against the global install at
`~/.bun/install/global/node_modules/omp-web/`.

The upstream package and this fork are both published as `omp-web` version
`0.5.1`, so npm cannot distinguish them. The install is therefore done from a
locally packed tarball, not from the registry.

## What is actually happening

| Piece | Location |
| --- | --- |
| Fork source | `D:/GitRepos/omp/omp-web` |
| Packed tarball | `D:/GitRepos/omp/omp-web-0.5.1.tgz` |
| Global install | `~/.bun/install/global/node_modules/omp-web/` |
| Global launcher | `~/.bun/bin/omp-web.exe` |
| Global manifest | `~/.bun/install/global/package.json` |

The drive letter is machine-specific. Substitute the actual repo root in every
path below — `bun add -g file:C:/...` fails with
`ENOENT extracting tarball` if the drive does not match.

The tarball is the unit of installation: `package.json`'s `files` list ships
`bin`, `.next`, `public`, `next.config.ts`, `package.json` — and **not** the
`.env` files. Those live only in the installed directory, so they must be
backed up and restored around the reinstall.

## Steps

### 1. Back up the `.env` files

```bash
mkdir -p "$TEMP/omp-web-backup"
cp ~/.bun/install/global/node_modules/omp-web/.env "$TEMP/omp-web-backup/.env"
cp ~/.bun/install/global/node_modules/omp-web/.env.local "$TEMP/omp-web-backup/.env.local"
```

On this machine both files carry:

```
OMP_WEB_ALLOWED_HOSTS=chi-pi.aitecl.com,chisunway-pi.aitecl.com
```

### 2. Build the fork

```bash
cd D:/GitRepos/omp/omp-web
bun run build
```

`bun run build` must not run against a live `bun run dev` — they share
`.next/`. Stop the dev server first.

### 3. Pack the fork into a tarball

Pack into the repo root, **not** a temp directory. `bun add -g` writes the
tarball's absolute path into `~/.bun/install/global/package.json`, so a temp
path leaves the global manifest pointing at a file that gets cleaned up.

```bash
cd D:/GitRepos/omp/omp-web
bun pm pack --destination D:/GitRepos/omp
```

Produces `D:/GitRepos/omp/omp-web-0.5.1.tgz` (~4.8 MB packed, ~16.6 MB unpacked, 645 files).

### 4. Uninstall the upstream package

```bash
cd ~
bun remove -g omp-web
```

This step **often fails with `EBUSY`** — see [Troubleshooting](#troubleshooting).
Expected output on success:

```
bun remove v1.4.4
Removed: 1
```

Verify the directory is gone:

```bash
test -d ~/.bun/install/global/node_modules/omp-web && echo STILL_EXISTS || echo REMOVED
```

### 5. Install the fork

```bash
cd ~
bun add -g "file:D:/GitRepos/omp/omp-web-0.5.1.tgz"
```

Using the `file:` prefix keeps the global manifest stable:

```json
"omp-web": "file:D:/GitRepos/omp/omp-web-0.5.1.tgz"
```

Expect ~190 packages installed in under a minute.

Two lifecycle scripts are blocked by bun's default trust policy
(`onnxruntime-node`, `protobufjs`). Run them explicitly:

```bash
cd ~
bun pm -g trust --all
```

Without this, `@huggingface/transformers` is missing its native ONNX runtime
binding for win32-x64.

### 6. Restore the `.env` files

```bash
cp "$TEMP/omp-web-backup/.env" ~/.bun/install/global/node_modules/omp-web/.env
cp "$TEMP/omp-web-backup/.env.local" ~/.bun/install/global/node_modules/omp-web/.env.local
```

### 7. Verify

```bash
# build ID of the installed app
cat ~/.bun/install/global/node_modules/omp-web/.next/BUILD_ID

# fork-only frontend marker present in the installed client bundle
grep -rl "data-minimap-node-index" ~/.bun/install/global/node_modules/omp-web/.next/static

# launcher present
ls ~/.bun/bin/omp-web.exe

# global manifest points at the repo tarball
jq . ~/.bun/install/global/package.json
```

The `data-minimap-node-index` marker belongs to the prompt-history browser
(commit `1e14431`). Two further markers from the same commit:
`minimap-preview-lock` and `chatMinimap.locateAssistant`.

Then start it and confirm the served page carries the same build ID as the
installed copy:

```bash
BUILD_ID=$(cat ~/.bun/install/global/node_modules/omp-web/.next/BUILD_ID)
~/.bun/bin/omp-web.exe -p 30156 &
curl -s http://127.0.0.1:30156/ | grep -o "$BUILD_ID"
```

Note that the marker lives in the **page chunk**, not in the HTML shell — the
root document is only ~9 KB and will not contain it. Check the chunk:

```bash
curl -s "http://127.0.0.1:30156/_next/static/chunks/app/page-6e485bc84d2f08fe.js" \
  | grep -o "data-minimap-node-index\|minimap-preview-lock\|chatMinimap.locateAssistant" | sort -u
```

Stop the test instance afterwards (`omp-web.exe`, the `node.exe` child, and the
`bun.exe --bun .../next/dist/bin/next start` child).

## SDK versions

The fork declares `@oh-my-pi/pi-*` at `~18.10.4`. That resolves to a **nested**
copy under `omp-web/node_modules/@oh-my-pi/` (all five packages at `18.10.4`) —
the same layout the upstream install had. The separate top-level
`@oh-my-pi/pi-coding-agent@18.20.0` (the `omp` CLI) is unaffected.

So the reinstall does **not** downgrade the `omp` CLI, and omp-web's in-process
SDK version is unchanged from before.

## A second upstream install under npm global

This machine had **two** upstream `omp-web` installs, and the npm one was
first on `PATH` — so `omp-web` resolved to npm's copy, not bun's:

```
C:\Users\chizu\AppData\Roaming\npm\omp-web.cmd   <- npm global, shadows bun
C:\Users\chizu\.bun\bin\omp-web.exe              <- bun global
```

Replacing only the bun install leaves the upstream build serving. Remove the
npm copy too:

```bash
npm uninstall -g omp-web
```

That fails with `EBUSY` when elevated processes hold the directory (see
[Troubleshooting](#troubleshooting)). The npm dir's *contents* are always
removable even while the directory itself is locked, so it can be emptied:

```bash
cd "$APPDATA/npm/node_modules/omp-web" && rm -rf ./* .next bin public node_modules
cd "$APPDATA/npm" && rm -f omp-web omp-web.cmd omp-web.ps1
```

That removes the upstream code and the `PATH` shims, which is what matters.
The leftover empty directory is cosmetic and disappears on the next reboot.

Verify which copy `PATH` resolves to:

```bash
which -a omp-web
```

The first hit must be `~/.bun/bin/omp-web.exe`.

## Troubleshooting

### `bun remove -g omp-web` fails with `EBUSY`

```
error: failed to remove node_modules\omp-web: EBUSY (Device or resource busy)
error: failed to remove node_modules\omp-web\node_modules\@oh-my-pi\pi-coding-agent: EBUSY
```

Cause: a stale omp worker broker still holds a directory handle on the old
install. The directory then cannot be deleted, renamed, or overwritten — every
attempt returns `Access is denied` or `os error 32`.

Find the holder with Sysinternals Handle:

```bash
curl -sSL -o handle.zip https://download.sysinternals.com/files/Handle.zip
unzip -o handle.zip
./handle64.exe -nobanner omp-web
```

```
bun.exe   pid: 42212  type: File   58: C:\Users\chizu\.bun\install\global\node_modules\omp-web\node_modules\@oh-my-pi\pi-coding-agent
```

Confirm the process is an orphan before killing it — check that its parent PID
no longer exists:

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=42212' | Select-Object ProcessId,ParentProcessId,CommandLine | Format-List"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=28228' | Select-Object ProcessId | Format-List"
```

An empty result for the parent means the broker is orphaned. Kill it:

```bash
powershell -NoProfile -Command "Stop-Process -Id 42212 -Force"
```

**Check for a live replacement broker before killing.** A running `omp` session
spawns its own broker; the current one had a different PID. Killing a live
broker stops in-flight worker jobs for that session.

After the kill the removal completes:

```bash
cd C:/ && rm -rf ~/.bun/install/global/node_modules/omp-web
test -d ~/.bun/install/global/node_modules/omp-web && echo STILL_EXISTS || echo REMOVED
```

### The holder is an *elevated* process

If `handle64.exe` reports `No matching handles found` while `mv` still fails
with `os error 32`, the holder is running elevated — a non-elevated Handle
cannot see its handles, and `Stop-Process` returns `Access is denied`.

Elevated MCP servers spawned by another session are the usual culprit. On
this machine, `npx @playwright/mcp@latest` and `firecrawl-mcp` (both started
Nov 13 by a still-running `claude.exe`) held the npm global `omp-web`
directory. `ps -ef` shows their real command lines even when CIM shows an
empty one:

```bash
ps -ef | grep -E "cmd\.exe|node\.exe" | tr -d '\r'
```

```
? 13332 28760  node.exe "C:\Program Files\nodejs\node.exe" ... npx-cli.js "@playwright/mcp@latest"
? 21680 32224  node.exe "C:\Program Files\nodejs\node.exe" ... npx-cli.js "-y" "firecrawl-mcp"
```

Do not kill those — they belong to another live session. Empty the directory
instead (see [A second upstream install under npm global](#a-second-upstream-install-under-npm-global));
the residual empty folder is harmless.

Note that the **bun** global dir and the **npm** global dir are separate
locks. One can be free while the other is held, so probe each independently:

```bash
mv ~/.bun/install/global/node_modules/omp-web /tmp/probe && echo BUN_FREE && mv /tmp/probe ~/.bun/install/global/node_modules/omp-web
mv "$APPDATA/npm/node_modules/omp-web" "$APPDATA/npm/node_modules/.probe" && echo NPM_FREE && mv "$APPDATA/npm/node_modules/.probe" "$APPDATA/npm/node_modules/omp-web"
```

### Port 30141 is already taken

`omp-web` defaults to port 30141 (`bin/omp-web-options.js`: `port ?? env.PORT ?? "30141"`).
If something else holds it, omp-web cannot start — and the holder is usually
not omp-web. On this machine port 30141 was held by an unrelated Express
server (`3mf-merger`). Check with:

```bash
netstat -ano | findstr 30141
```

Use `-p <port>` for a scratch instance, or set `PORT`.

### `bun upgrade omp-web` overwrites the fork

The fork and upstream share the version number `0.5.1`. `bun upgrade omp-web`
pulls from the registry and reinstalls upstream's build. Reinstall from the
repo tarball instead (steps 3, 5, 6).

## Notes

- The fork does not bump `package.json`; it is still `0.5.1`. Bump it before
  publishing, or the registry will serve different content under the same
  version number.
- The tarball at `D:/GitRepos/omp/omp-web-0.5.1.tgz` is a build artifact.
  Regenerate it with step 3 after every source change.
- Web auth state is stored outside the package, so it survives the reinstall.
  Default location is `~/.omp/agent/omp-web-auth.json`
  (`$PI_CODING_AGENT_DIR`, `$PI_CONFIG_DIR`, or `$OMP_PROFILE` shift it;
  `$OMP_WEB_AUTH_FILE` overrides the path entirely).
