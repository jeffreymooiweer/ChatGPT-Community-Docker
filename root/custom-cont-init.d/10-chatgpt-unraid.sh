#!/usr/bin/with-contenv bash
set -euo pipefail
umask 077

CONFIG_DIR="${CHATGPT_CONFIG_DIR:-/config}"
DEFAULTS_DIR="${CHATGPT_DEFAULTS_DIR:-/defaults}"
APP_USER="${CHATGPT_APP_USER:-abc}"
APP_GROUP="${CHATGPT_APP_GROUP:-abc}"
ENABLE_HOST_SSH="${ENABLE_HOST_SSH:-false}"
case "$ENABLE_HOST_SSH" in
    true|false) ;;
    *) echo '[chatgpt-community] ENABLE_HOST_SSH must be true or false.' >&2; exit 1 ;;
esac

SSH_DIR="$CONFIG_DIR/.ssh"
SSH_KEY="$SSH_DIR/id_ed25519"
WORKSPACE="$CONFIG_DIR/workspace/server"
# Preserve the original workspace location for existing installations.
[ ! -d "$CONFIG_DIR/workspace/unraid" ] || WORKSPACE="$CONFIG_DIR/workspace/unraid"
BACKUP="$CONFIG_DIR/.local/state/chatgpt-community/migration-single-app-v1"
mkdir -p "$CONFIG_DIR/workspace" "$BACKUP"
chmod 0700 "$BACKUP"
# Newly created parent directories must be traversable by the session user.
mkdir -p "$CONFIG_DIR/.config"
chown "$APP_USER:$APP_GROUP" "$CONFIG_DIR/.config" "$CONFIG_DIR/workspace" \
    "$CONFIG_DIR/.local" "$CONFIG_DIR/.local/state" \
    "$CONFIG_DIR/.local/state/chatgpt-community" "$BACKUP"

# Host administration is opt-in. Disabled means no SSH provisioning, not
# revocation: leave all existing keys, aliases and user instructions untouched.
if [ "$ENABLE_HOST_SSH" = true ]; then
    # Only validate settings when creating a new config. Existing user configs
    # take precedence, including non-default users, ports and host aliases.
    if [ ! -e "$SSH_DIR/config" ]; then
        SSH_HOST="${SSH_HOST:-${UNRAID_HOST:-}}"
        SSH_USER="${SSH_USER:-root}"
        SSH_PORT="${SSH_PORT:-22}"
        [[ "$SSH_HOST" =~ ^[a-zA-Z0-9:][a-zA-Z0-9._:-]*$ ]] || {
            echo '[chatgpt-community] SSH setup requires a valid SSH_HOST (or legacy UNRAID_HOST).' >&2
            exit 1
        }
        [[ "$SSH_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*[$]?$ ]] || {
            echo '[chatgpt-community] Invalid SSH_USER.' >&2; exit 1
        }
        [[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$SSH_PORT >= 1 && 10#$SSH_PORT <= 65535 )) || {
            echo '[chatgpt-community] SSH_PORT must be between 1 and 65535.' >&2; exit 1
        }
    fi
    mkdir -p "$SSH_DIR" "$WORKSPACE"
    chmod 0700 "$SSH_DIR"

# Do not rotate an existing SSH identity or overwrite custom host aliases.
if [ ! -f "$SSH_KEY" ]; then
    ssh-keygen -q -t ed25519 -N '' -C chatgpt-community@unraid -f "$SSH_KEY"
fi
if [ ! -s "$SSH_KEY.pub" ]; then
    ssh-keygen -y -P '' -f "$SSH_KEY" > "$SSH_KEY.pub"
fi
if [ ! -e "$SSH_DIR/config" ]; then
    cat > "$SSH_DIR/config" <<EOF
Host server unraid
    HostName $SSH_HOST
    User $SSH_USER
    Port $SSH_PORT
    IdentityFile $SSH_KEY
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
    ServerAliveInterval 30
    ServerAliveCountMax 3
EOF
fi
chmod 0600 "$SSH_KEY" "$SSH_DIR/config"
chmod 0644 "$SSH_KEY.pub"
chown "$APP_USER:$APP_GROUP" "$SSH_DIR" "$SSH_KEY" "$SSH_KEY.pub" "$SSH_DIR/config"

if [ ! -e "$WORKSPACE/AGENTS.md" ]; then
    cat > "$WORKSPACE/AGENTS.md" <<'EOF'
# Optional Server Administration Workspace

The local shell belongs to the ChatGPT container, not the host.
SSH setup was requested, but the host may not have authorized the key yet.
Inspect ~/.ssh/config and confirm the target and account before connecting.
For the generated alias, a read-only identity check is:

```bash
ssh unraid 'hostname; id'
```

Do not assume root access or authorization for changes. Obtain explicit
approval before deleting data, formatting storage, changing boot/network/SSH
configuration, or stopping this container. Never expose tokens or private keys.
Root inside this container is not host root. Only use mounted paths and
authorized connections. Do not stop or update the container hosting this task.
EOF
    chown "$APP_USER:$APP_GROUP" "$WORKSPACE/AGENTS.md"
fi
chown "$APP_USER:$APP_GROUP" "$WORKSPACE"
    echo '[chatgpt-community] Optional SSH setup ready; authorize the public key separately on the target host.'
    echo '[chatgpt-community] SSH public key:'
    cat "$SSH_KEY.pub"
else
    echo '[chatgpt-community] Standard mode: SSH setup skipped; existing SSH files and workspaces left unchanged.'
fi

# Selkies only seeds autostart files on first use. Migrate old Webtop copies
# explicitly, keeping originals for rollback. Never touch .codex or Codex.
for wm in labwc openbox; do
    dir="$CONFIG_DIR/.config/$wm"
    mkdir -p "$dir"
    source="$DEFAULTS_DIR/autostart"
    [ "$wm" != labwc ] || source="$DEFAULTS_DIR/autostart_wayland"
    if ! cmp -s "$source" "$dir/autostart"; then
        if [ -e "$dir/autostart" ] && [ ! -e "$BACKUP/$wm-autostart" ]; then
            cp -p "$dir/autostart" "$BACKUP/$wm-autostart"
        fi
        install -m 0755 "$source" "$dir/autostart"
    fi
    chown "$APP_USER:$APP_GROUP" "$dir" "$dir/autostart"
done
legacy="$CONFIG_DIR/.config/autostart/chatgpt-community.desktop"
if [ -f "$legacy" ]; then
    if [ ! -f "$BACKUP/chatgpt-community.desktop" ]; then
        cp -p "$legacy" "$BACKUP/chatgpt-community.desktop"
    fi
    rm -- "$legacy"
fi

echo '[chatgpt-community] Single-application session configured; existing credentials preserved.'
if [ -z "${PASSWORD:-}" ]; then
    echo '[chatgpt-community] WebUI login disabled (PASSWORD is blank); use a trusted LAN/VPN. Set PASSWORD to enable login.' >&2
fi
