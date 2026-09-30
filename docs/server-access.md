# Optional server access

**Normal app use and selected-folder access do not need SSH or host root.**
This option is for users who intentionally want to execute commands on a server.
It is not enabled by merely installing the image.

Using the Unraid template? Jump to [Unraid setup](#unraid-setup).

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

## Unraid setup

SSH is optional. Skip this section if you only want the app or access to selected
folders. These steps deliberately authorize **full root access to your Unraid
server**. Do not enable Privileged mode or mount the Docker socket for this.

### 1. Enable the server's SSH service

In Unraid, open **Settings → Management Access**. Set **Use SSH** to **Yes**,
note the **SSH port** (normally `22`), and apply if you changed anything. Keep
access on your trusted LAN/VPN; do not add an internet-facing port forward.

### 2. Configure the container

In **Docker → ChatGPT-Community → Edit**, enable **Advanced View** and set:

| Template field | Value |
| --- | --- |
| Advanced: provision host SSH | `true` |
| Advanced: SSH host | Your Unraid server's reachable LAN IP address or hostname |
| Advanced: SSH user | `root` |
| Advanced: SSH port | The port from step 1, usually `22` |

Do not use `localhost`: inside the container that means the container itself.
Keep your existing **Appdata** path to preserve your app data and SSH identity.

**Finish active app tasks before clicking Apply.** Applying these settings
recreates the container and interrupts sessions, including any agent working
inside it. Provisioning creates missing keys/config; it does not authorize them.
If you already have an SSH config, see [Existing installations](#existing-installations-and-disabling-setup)
before changing the fields: existing connections are not overwritten.

### 3. Authorize the public key

Open **Docker → ChatGPT-Community → Logs**. With provisioning enabled, startup
prints a public-key line beginning with `ssh-ed25519`. Copy that entire line,
without the log prefix. It is one key even if your screen wraps the line.

Alternatively, run this in the **Unraid host Terminal**:

```bash
docker exec -u abc ChatGPT-Community cat /config/.ssh/id_ed25519.pub
```

Use your actual container name if you renamed it. Only the `.pub` file is meant
to be copied; never share the private `id_ed25519` file.

Open **Users → root → SSH authorized keys**. Add the public key on a **new line**,
leaving all existing keys intact, then click **Save**. On Unraid versions with
this field, the UI maintains the persistent root authorization on the flash
drive. Do not replace the entire file with just this key. If your version does
not offer this field, follow that version's documented persistent SSH-key setup
rather than editing only a temporary file under `/root`.

### 4. Verify the host identity and test

Before the first connection, check the host's Ed25519 fingerprint in the trusted
**Unraid host Terminal**:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Then open **Docker → ChatGPT-Community → Console** and run the following, replacing
`YOUR_SERVER_IP` and `22` with your server address and SSH port:

```bash
ssh-keyscan -t ed25519 -p 22 YOUR_SERVER_IP 2>/dev/null | ssh-keygen -lf -
```

Compare the `SHA256:...` fingerprint with the host Terminal output. A scan alone
does not authenticate a server; **stop if they do not match**. This scan does not
add a key to `known_hosts`. Once verified, test from that same container Console:

```bash
su -s /bin/sh abc -c "ssh server 'hostname; id'"
```

Run as `abc`, the app's user, so SSH uses the app's keys/config rather than the
container root account's home. Success prints your Unraid hostname and
`uid=0(root)`. The generated config remembers the host key on first use. Never
ignore a changed-host-key warning. Older preserved configs may use the alias
`unraid` instead of `server`.

The new-install starter workspace is `/config/workspace/server`; older installs
may keep `/config/workspace/unraid`. Its instructions explain the SSH connection
to the app. Container-local commands still run inside the container unless SSH
is explicitly used. Never ask the app to stop or update its own running container.

### Troubleshooting and revoking access

- **No public key:** check that provisioning is `true`, the host field is filled
  in, you applied the settings, and startup logs show no configuration error.
- **Connection refused:** check the host's SSH service and matching port.
- **Timeout:** check the LAN address, firewall and Docker network. Some custom
  macvlan/ipvlan networks isolate containers from their host; SSH keys cannot fix
  that connectivity problem. Do not enable Privileged as a workaround.
- **Permission denied (publickey):** verify the complete `.pub` line was saved
  for `root`, that you used the correct container's key, and that the test runs
  as `abc`.
- **Could not resolve hostname server / wrong target:** an existing
  `/config/.ssh/config` is preserved. Check its aliases and destination; older
  installations may need `ssh unraid` instead. Changing template variables will
  not rewrite that existing file.
- **Revoke access:** remove only this container's public-key line from
  **Users → root → SSH authorized keys**, then **Save**. Setting provisioning to
  `false` alone does not revoke access. Revoking a key blocks new logins; already
  open SSH sessions may remain active until closed.

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
