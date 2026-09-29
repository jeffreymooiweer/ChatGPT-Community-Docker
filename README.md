# ChatGPT Community — Docker Image

[![Build](https://github.com/jeffreymooiweer/ChatGPT-Community-Docker/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/jeffreymooiweer/ChatGPT-Community-Docker/actions/workflows/build.yml)
[![Docker image](https://img.shields.io/badge/Docker_image-GHCR-2496ED?logo=docker&logoColor=white)](https://github.com/jeffreymooiweer/ChatGPT-Community-Docker/pkgs/container/chatgpt-community-docker)
[![Unraid ready](https://img.shields.io/badge/Unraid-ready-F15A2C?logo=unraid&logoColor=white)](unraid/chatgpt-community.xml)
[![Platform](https://img.shields.io/badge/platform-linux%2Famd64-555555?logo=linux&logoColor=white)](compose.yaml)
[![Docker packaging license: MIT](https://img.shields.io/badge/Docker_packaging-MIT-3DA639)](LICENSE)

Run [ChatGPT Community for Linux](https://github.com/ilysenko/codex-desktop-linux)
on your Docker server and use the app from your browser—without a full remote desktop.

**Credit for ChatGPT Community belongs to its upstream authors and contributors.**
This repository provides Docker packaging and an automated build workflow.
It does not develop the upstream application.

> Unofficial community project, not affiliated with OpenAI or LinuxServer.io.
> This is not a local AI model. Online features require an internet connection
> and an eligible account; account limits still apply.

## Docker image

```text
ghcr.io/jeffreymooiweer/chatgpt-community-docker:latest
```

**Architecture:** `linux/amd64` (64-bit Intel/AMD). GPU acceleration and host SSH
access are optional.

[Image tags](https://github.com/jeffreymooiweer/ChatGPT-Community-Docker/pkgs/container/chatgpt-community-docker)
· [Build status](https://github.com/jeffreymooiweer/ChatGPT-Community-Docker/actions/workflows/build.yml)
· [Report an issue](https://github.com/jeffreymooiweer/ChatGPT-Community-Docker/issues)

An [Unraid template](unraid/chatgpt-community.xml) is also available.

## Choose your access level

| Level | What it does | What you configure |
| --- | --- | --- |
| **Standard — default** | Runs the app with persistent settings and workspaces. No automatic host SSH setup. | Appdata and the WebUI port. No host address or SSH service needed. |
| **Optional — selected files** | Lets the app work with specific folders you choose. | Folder mappings, read-only or read/write. No SSH needed. |
| **Advanced — server administration** | Prepares SSH access using a server account you authorize separately. | Explicit SSH opt-in, connection settings, and host-side key authorization. |

These are configuration choices, not a permission sandbox. Existing credentials
and integrations may still grant access. No mode automatically enables
Privileged, mounts the Docker socket, or grants host root.

## Install with Docker Compose

Save [compose.yaml](compose.yaml) in an empty folder on your Docker server.
Before starting:

- Set `PUID` and `PGID` to the user/group IDs that should own appdata. On Linux,
  check these with `id -u` and `id -g`; the example uses `1000`.
- Set `TZ` to your timezone if desired.
- For access from another device, replace `127.0.0.1` in the port mapping with
  your server's trusted LAN IP. The default allows access only from the Docker host.
- Optionally set `PASSWORD` for an extra WebUI login. Leaving it blank skips
  that prompt; it does not remove your application account login.

Then, from the folder containing the file:

```bash
docker compose up -d
```

Open **https://localhost:33443** on the Docker host, or
**https://YOUR-SERVER-IP:33443** when you configured LAN access.

HTTPS uses a self-signed certificate. Only accept the warning after checking
that the address is your own server. Sign in to the application with your account.

Settings and local workspaces persist in `./appdata` beside the Compose file.
Back up this complete folder, including hidden files. It may contain credentials.

## Install with plain Docker

Alternatively, use a named Docker volume for persistent appdata:

```bash
docker run -d \
  --name chatgpt-community \
  --hostname chatgpt-community \
  --restart unless-stopped \
  --shm-size=1g \
  -p 127.0.0.1:33443:3001 \
  -e PUID=1000 -e PGID=1000 -e TZ=Etc/UTC \
  -e ENABLE_HOST_SSH=false \
  -v chatgpt-community-config:/config \
  ghcr.io/jeffreymooiweer/chatgpt-community-docker:latest
```

Adjust the IDs, timezone, and listen address as described above. To enable the
extra WebUI login, add `-e PASSWORD` before the image name and supply a strong
`PASSWORD` through your shell environment.

**Choose one method.** The Docker command uses the `chatgpt-community-config`
volume; Compose uses `./appdata`. They are different storage locations. When
migrating an existing installation, keep its original `/config` source and
container hostname. Do not delete the volume or folder during an update.

## Optional: access selected folders

Add a mapping to your existing Compose `volumes` list:

```yaml
- /absolute/path/to/project:/workspace/project:ro
```

With `docker run`, add `--mount type=bind,src=/absolute/path/to/project,dst=/workspace/project,readonly`
before the image name. Replace the source with a real host folder, then open
`/workspace/project` inside the app.

Read-only access allows inspection. Use `:rw` in Compose, or remove `readonly`
from the Docker option, only if the app should change or delete files.
Host file permissions still apply. This grants file access, not full server
administration. Avoid mounting your entire server or sensitive configuration.
See [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/).

## Optional: GPU

For a supported Intel/AMD GPU, add `--device=/dev/dri:/dev/dri` with Docker or
uncomment the `devices` example in Compose. Omit it when the device is absent.
Otherwise CPU rendering is used. This accelerates the interface, not cloud AI
models. The examples do not configure NVIDIA support.

## Configuration reference

| Setting | Purpose |
| --- | --- |
| `3001/tcp` | HTTPS port inside the container; the examples publish host port `33443`. |
| `/config` | Persistent appdata, including credentials and local workspaces. |
| `PASSWORD` | Optional WebUI password; blank/unset means no extra login. |
| `CUSTOM_USER` | WebUI username when a password is set; default `abc`. |
| `PUID` / `PGID` | User/group IDs for access to appdata and shared files. |
| `TZ` | Your timezone. |
| `ENABLE_HOST_SSH` | Default `false`. Set `true` only to provision an SSH identity/config. |
| `PIXELFLUX_WAYLAND` | Default `true`; `false` selects the X11 display fallback. |

## Advanced: server administration

See [optional server access](docs/server-access.md) for SSH setup, non-root
accounts, and connecting to the Docker host. This mode is optional; there is no
built-in SSH-free full-host administration mode. Root inside the container is
not automatically root on the server.

**Existing users:** your SSH keys, configs, and custom workspace instructions
are preserved. `ENABLE_HOST_SSH=false` skips automatic setup; it does **not**
revoke a previously authorized connection. Existing SSH configs are not
rewritten when environment variables change.

## Updates and troubleshooting

The workflow checks upstream every six hours and runs a weekly refresh. Only
candidates that pass the required checks are published as `latest`. Upstream
changes can still require maintenance; failed candidates leave the previous
published image available. Previous builds have unique `build-...` tags.

Code changes rebuild the recorded, tested app version. Scheduled checks and
manual workflow runs test newer upstream versions before promoting them.

Publication does not update running containers. Finish active tasks and back up
appdata before updating. For Compose:

```bash
docker compose pull
docker compose up -d
```

For plain Docker, pull the new image and recreate the container with the same
storage and settings. A plain restart does not apply new environment variables.
Never run two instances against the same appdata. Rolling back may require a
matching data backup as well as an older image.

Closing a browser tab leaves the app running; restarting the container interrupts
active sessions. For errors, inspect `docker compose logs --tail=100` or
`docker logs --tail 100 chatgpt-community`. For display issues, try
`PIXELFLUX_WAYLAND=false` after finishing active work. Remove secrets from logs
before posting them in an issue.

## Security and credits

Keep the WebUI on a trusted LAN or VPN—not directly on the internet. Without a
WebUI password, anyone who can reach its port can use your logged-in app and
connected tools. Protect appdata and backups. The app uses `--no-sandbox`,
disabling Chromium's internal sandbox; agent approvals are separate. Do not
rely on the container as a strong security boundary after granting host access.

Remote Mobile Control is experimental, separate from SSH setup, and depends on
upstream and account availability.
[Upstream feature documentation](https://github.com/ilysenko/codex-desktop-linux/tree/main/linux-features/remote-mobile-control).

- **[ChatGPT Community for Linux](https://github.com/ilysenko/codex-desktop-linux)** — the upstream authors and contributors, for the community app distribution and Linux adaptations.
- **OpenAI** — the underlying application, AI services, and associated assets.
- **[LinuxServer.io Selkies](https://docs.linuxserver.io/selkies/)** — the browser-streaming foundation.

This repository contributes Docker packaging only.
Third-party software and assets retain their respective licenses and terms.
