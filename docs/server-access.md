# Optional server access

**Normal app use and selected-folder access do not need SSH or host root.**
This option is for users who intentionally want to execute commands on a server.
It is not enabled by merely installing the image.

## Enable SSH provisioning

Add these variables under your Compose service's existing `environment` section.
Replace its existing `ENABLE_HOST_SSH` value rather than duplicating the key:

```yaml
ENABLE_HOST_SSH: "true"
SSH_HOST: "your-server-hostname"
SSH_USER: "your-server-account"
SSH_PORT: "22"
```

Replace the host and account with real values. With plain Docker, use equivalent
`-e NAME=value` options before the image name. Unraid exposes the same options in
the template's Advanced View. Applying new environment variables recreates the
container and interrupts active tasks.

- `ENABLE_HOST_SSH` accepts `true` or `false`; its default is `false`.
- `SSH_HOST` is required for a new SSH config. The older `UNRAID_HOST` variable
  remains accepted as a fallback; `SSH_HOST` takes precedence.
- `SSH_USER` defaults to `root`, but can name a non-root account where supported.
  The account's host permissions determine what the app can do. Root
  authorization grants full host control; choose a restricted account when possible.
- `SSH_PORT` defaults to `22`.

Enabled provisioning creates missing keys at `/config/.ssh/id_ed25519` and a
config with the aliases `server` and `unraid`. Missing starter instructions are
created in `/config/workspace/server`, or in the legacy `/config/workspace/unraid`
directory when that directory already exists.

It does **not** enable an SSH service, contact the host, add authorized keys, or
grant access automatically. The target must already accept SSH connections.

## Authorize the public key

For Compose, display the public key with:

```bash
docker compose exec -u abc chatgpt-community cat /config/.ssh/id_ed25519.pub
```

For plain Docker, use:

```bash
docker exec -u abc chatgpt-community cat /config/.ssh/id_ed25519.pub
```

Replace the container name if different; the Unraid template uses
`ChatGPT-Community`. Authorize this **public** key on the target using your normal
administration process, for the account selected in `SSH_USER`.

Never share the private file `id_ed25519`. Preserve other authorized keys and use
restrictive permissions. On Unraid, account for persistence across host reboots;
this image does not manage host-side SSH configuration.

The generated config accepts unknown host keys on first use. Verify the target's
host-key fingerprint through a trusted channel before connecting. Do not blindly
discard a changed-host-key warning.

After authorization, a read-only identity check for Compose is:

```bash
docker compose exec -u abc chatgpt-community ssh server 'hostname; id'
```

Older preserved configs may only have the `unraid` alias; use that alias instead.
An unsuccessful connection does not justify enabling Privileged or exposing Docker.

## Connecting to the same Docker host

In normal bridge networking, `localhost` refers to the container, not your
server. Use the host's reachable LAN hostname/IP. Alternatively, Docker Engine
supports this Compose service-level mapping:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

Then set `SSH_HOST` to `host.docker.internal`. For `docker run`, add
`--add-host=host.docker.internal:host-gateway`. The host must still run SSH and
allow the connection. Resolving its address does not grant any permissions.
See [Docker networking](https://docs.docker.com/compose/how-tos/networking/#custom-dns-with-extra_hosts).

## Existing installations and disabling setup

Existing SSH identities, configs, known hosts, and customized workspace
instructions are preserved. Connection variables only configure a **new** SSH
config; they do not rewrite one that already exists.

Setting `ENABLE_HOST_SSH=false` stops automatic provisioning. It does **not**
disable the SSH client, delete credentials, or revoke authorized connections.
To revoke access, remove this specific public-key authorization on the target
using its normal administration process. Do not remove other users' keys.

## What about access without SSH?

Folder mappings provide file access without SSH. This image does not provide a
privileged host agent or an SSH-free full-host administration mode.

Root inside a container is not automatically root on the host. Unrestricted
Docker-socket access can effectively grant host root, and Privileged removes
important isolation. Neither is enabled by the examples or template.
See [Docker security](https://docs.docker.com/engine/security/).

Never have the app stop or update the container hosting its active task.
