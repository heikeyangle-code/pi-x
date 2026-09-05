# @ccpocket/bridge

Bridge server that connects local [pi](https://pi.dev) engine sessions to mobile devices via WebSocket.

This is the server component of [ccpocket](https://github.com/K9i-0/ccpocket) — a mobile client for the pi coding agent.

## Quick Start

```bash
PI_ENGINE_ENTRY=/absolute/path/to/pi npx @ccpocket/bridge@latest
```

A QR code will appear in your terminal. Scan it with the ccpocket mobile app to connect.

The Bridge is pi-only: it drives the local `pi` engine (via `pi --mode rpc`) and
requires `PI_ENGINE_ENTRY` to point at the pi CLI entry. There is no Claude or
Codex fallback — see [docs/ENGINE-BUNDLE.md](../../docs/ENGINE-BUNDLE.md) for
how to build and bundle an engine.

## Installation

```bash
# Recommended: run the latest Bridge directly
npx @ccpocket/bridge@latest

# Optional: install globally
npm install -g @ccpocket/bridge
ccpocket-bridge

# Show CLI help or version
ccpocket-bridge --help
ccpocket-bridge --version
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PI_ENGINE_ENTRY` | (required) | Absolute path to the pi CLI entry (e.g. `<engine>/node_modules/.bin/pi`). The Bridge refuses to start without it |
| `PI_ENGINE_VERSION` | `dev` | Reported pi engine version |
| `PI_HOME` | `$HOME` | Base directory for pi data (`~/.pi/agent/sessions`, `~/.pi/agent/auth.json`) |
| `BRIDGE_PORT` | `8765` | WebSocket port |
| `BRIDGE_HOST` | `0.0.0.0` | Bind address |
| `BRIDGE_API_KEY` | (none) | API key authentication (enabled when set) |
| `BRIDGE_ALLOWED_DIRS` | `$HOME` | Comma-separated list of project directories the Bridge may access; set exactly to `*` to allow any directory |
| `BRIDGE_PUBLIC_WS_URL` | (none) | Public `ws://` / `wss://` URL used for startup deep link and QR code |
| `BRIDGE_DEMO_MODE` | (none) | Demo mode: hide Tailscale IPs and API key from QR code / logs |
| `BRIDGE_RECORDING` | (none) | Enable session recording for debugging (enabled when set) |
| `BRIDGE_DISABLE_MDNS` | (none) | Disable mDNS auto-discovery advertisement (macOS disables it automatically) |
| `BRIDGE_PROMPT_HISTORY_FILE` | `$HOME/.ccpocket/prompt-history-v2.json` | Custom prompt history store path |
| `BRIDGE_RECENT_SESSIONS_PROFILE` | (none) | Log recent-session index timing when set to `1` or `true` |
| `BRIDGE_FILE_LIST_MAX_ENTRIES` | `5000` | Maximum file and directory entries returned to a client; non-positive or invalid values use the default |
| `BRIDGE_FILE_LIST_MAX_BYTES` | `524288` | Maximum serialized path bytes returned in a client file list; non-positive or invalid values use the default |
| `BRIDGE_FILE_DOWNLOAD_MAX_SIZE_MB` | `512` | Maximum size in MiB for a file downloaded from Explorer; non-positive or invalid values use the default |
| `BRIDGE_FILE_UPLOAD_MAX_SIZE_MB` | `512` | Maximum size in MiB for one file uploaded from Explorer; non-positive or invalid values use the default |
| `BRIDGE_FILE_UPLOAD_MAX_RESERVED_MB` | `2048` | Maximum total declared bytes reserved by pending Explorer uploads |
| `BRIDGE_FILE_UPLOAD_MAX_CONCURRENT` | `4` | Maximum number of Explorer upload bodies received concurrently |
| `BRIDGE_DELTA_BATCH_MS` | `100` | Milliseconds to batch streaming deltas per connected client; set to `0` to disable batching |
| `BRIDGE_DELTA_BATCH_MAX_CHARS` | `4096` | Maximum Unicode characters per batched streaming payload; non-positive or invalid values use the default |
| `DIFF_IMAGE_AUTO_DISPLAY_KB` | `1024` (1 MB) | Auto-display diff images up to this size, in KB |
| `DIFF_IMAGE_MAX_SIZE_MB` | `5` (5 MB) | Maximum diff image size available for on-demand loading, in MB |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | (none) | Proxy for outgoing fetch requests (`http://`, `https://`, `socks4://`, `socks5://`) |

Lowercase proxy variables (`https_proxy`, `http_proxy`, `all_proxy`) are also
supported. When `BRIDGE_PROMPT_HISTORY_FILE` is not set and `BRIDGE_PORT` is not
`8765`, prompt history is stored in
`$HOME/.ccpocket/prompt-history-v2-<port>.json`.

The Bridge is local-only: no Firebase Anonymous Auth, no remote push relay. The
mobile app connects over the local network (or localhost) and receives all
events over the WebSocket in real time.

## Pi engine setup

The Bridge requires the local pi engine. Point `PI_ENGINE_ENTRY` at the pi CLI
entry (the absolute path to the `pi` binary, e.g.
`<engine>/node_modules/.bin/pi`) and verify with the doctor command:

```bash
PI_ENGINE_ENTRY=/absolute/path/to/pi npx @ccpocket/bridge@latest doctor
```

Doctor checks that the pi CLI runs, that credentials exist
(`~/.pi/agent/auth.json`), and that the Bridge can reach it. If the pi entry is
missing, the Bridge refuses to start instead of falling back to another engine.

```bash
# Example: custom port with API key
PI_ENGINE_ENTRY=/absolute/path/to/pi BRIDGE_PORT=9000 BRIDGE_API_KEY=my-secret \
  npx @ccpocket/bridge@latest

# Example: allow projects outside $HOME
PI_ENGINE_ENTRY=/absolute/path/to/pi \
  BRIDGE_ALLOWED_DIRS="$HOME,/scratch/$USER" npx @ccpocket/bridge@latest

# Example: expose Bridge through a reverse proxy / ngrok
BRIDGE_PUBLIC_WS_URL=wss://example.ngrok-free.app npx @ccpocket/bridge@latest

# Example: same setting via CLI flag
ccpocket-bridge --public-ws-url wss://example.ngrok-free.app

# Example: disable mDNS advertisement
BRIDGE_DISABLE_MDNS=1 npx @ccpocket/bridge@latest
# or via CLI flag
ccpocket-bridge --no-mdns
```

When `BRIDGE_PUBLIC_WS_URL` is set, the startup deep link and terminal QR code
use that public URL instead of the LAN address. This is useful when the Bridge
is reachable through a reverse proxy, tunnel, or public domain.

Without it, the printed QR code is LAN-oriented by default and typically encodes
something like `ws://192.168.x.x:8765`.

## Persistent service setup

Register the Bridge as a user-level background service:

```bash
npx @ccpocket/bridge@1 setup
```

Setup supports macOS launchd and Linux systemd. It persists the Bridge settings
that affect startup:

- `BRIDGE_PORT` / `--port`
- `BRIDGE_HOST` / `--host`
- `BRIDGE_API_KEY` / `--api-key`
- `BRIDGE_ALLOWED_DIRS`
- `BRIDGE_PUBLIC_WS_URL` / `--public-ws-url`
- `BRIDGE_DISABLE_MDNS` / `--no-mdns`

Example:

```bash
PI_ENGINE_ENTRY=/absolute/path/to/pi \
BRIDGE_ALLOWED_DIRS="$HOME,/scratch/$USER" \
BRIDGE_API_KEY=my-secret \
npx @ccpocket/bridge@1 setup
```

The service inherits the rest of the environment through a login shell (`zsh
-li` on macOS, `bash -lc` on Linux), so `PI_ENGINE_ENTRY`, `PI_HOME`, and proxy
settings exported in `~/.zprofile` / `~/.zshrc` / `~/.profile` /
`~/.bash_profile` are available to the Bridge. On Linux, setup gives standalone
installations priority by including `$HOME/.local/bin` before npm-managed Node
paths in the service `PATH`.

## Requirements

- Node.js v20.18.1+
- The [pi](https://pi.dev) engine CLI, reachable at `PI_ENGINE_ENTRY`

See [docs/ENGINE-BUNDLE.md](../../docs/ENGINE-BUNDLE.md) for building and
bundling an engine, and [docs/M2-WIRING.md](../../docs/M2-WIRING.md) for how
the Bridge wires pi into the server.

## Health Check

Run the built-in doctor command to verify your environment:

```bash
PI_ENGINE_ENTRY=/absolute/path/to/pi npx @ccpocket/bridge@latest doctor
```

It checks Node.js, Git, the pi engine entry, pi credentials, macOS permissions
(Screen Recording, Keychain), network connectivity, and more.

## Architecture

```
Mobile App ←WebSocket→ Bridge Server ←RPC (pi --mode rpc)→ pi Engine
```

The Bridge spawns the local pi engine and translates WebSocket messages to/from
the engine's RPC interface. It supports multiple concurrent sessions, all driven
by the local pi engine.

## License

This package is MIT licensed as part of CC Pocket. See [LICENSE](./LICENSE) and
the repository root [LICENSE](../../LICENSE).
