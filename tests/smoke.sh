#!/usr/bin/env bash
set -euo pipefail
IMAGE="${1:?Supply the candidate image tag}"
mkdir -p test-results
name=''
fixture="$(mktemp -d)"
chmod 755 "$fixture"
printf 'read-only-project\n' > "$fixture/probe.txt"
chmod 644 "$fixture/probe.txt"
collect() {
    [ -n "$name" ] || return 0
    docker logs "$name" > "test-results/$name-container.log" 2>&1 || true
    docker port "$name" > "test-results/$name-ports.log" 2>&1 || true
    docker cp "$name:/config/.cache/chatgpt-community/startup.log" \
        "test-results/$name-app.log" >/dev/null 2>&1 || true
}
cleanup() {
    collect
    [ -z "$name" ] || docker rm -fv "$name" >/dev/null 2>&1 || true
}
finish() {
    cleanup
    rm -- "$fixture/probe.txt"
    rmdir -- "$fixture"
}
trap finish EXIT

wait_ready() {
    local minimum_initializations="${1:-1}"
    local attempt port initializations
    local -a auth=()
    [ -z "$password" ] || auth=(-u "abc:$password")
    for attempt in $(seq 1 90); do
        # Docker may assign a different ephemeral host port after a restart.
        port="$(docker port "$name" 3001/tcp 2>/dev/null | sed -n '1s/.*://p' || true)"
        initializations="$(docker exec "$name" grep -c 'Codex CLI initialized' \
            /config/.cache/chatgpt-community/startup.log 2>/dev/null || true)"
        if [[ "$port" =~ ^[0-9]+$ ]] \
            && [[ "$initializations" =~ ^[0-9]+$ ]] \
            && [ "$initializations" -ge "$minimum_initializations" ] \
            && docker exec "$name" pgrep -x ChatGPT >/dev/null 2>&1 \
            && docker exec "$name" pgrep -x codex >/dev/null 2>&1 \
            && curl -kfsS --max-time 5 "${auth[@]}" \
                "https://127.0.0.1:$port/" >/dev/null 2>&1; then
            echo "Ready: $name on HTTPS port $port (initializations=$initializations)"
            return 0
        fi
        sleep 2
    done
    echo "Application did not become ready: $name" >&2
    collect
    cat "test-results/$name-ports.log" >&2
    tail -n 120 "test-results/$name-container.log" >&2
    [ ! -f "test-results/$name-app.log" ] || tail -n 120 "test-results/$name-app.log" >&2
    return 1
}

for scenario in standard-x11 standard-wayland advanced-wayland; do
    name="chatgpt-smoke-$scenario"
    wayland=true
    [ "$scenario" != standard-x11 ] || wayland=false
    ssh_setup=false
    password=''
    if [ "$scenario" = advanced-wayland ]; then
        ssh_setup=true
        password="$(openssl rand -hex 24)"
    fi
    mount_args=()
    if [ "$scenario" = standard-wayland ]; then
        mount_args=(--mount "type=bind,src=$fixture,dst=/workspace/shared,readonly")
    fi
    docker run -d --name "$name" --shm-size=1g \
        -p 127.0.0.1::3001 -e PUID=1000 -e PGID=1000 \
        -e "PIXELFLUX_WAYLAND=$wayland" -e "PASSWORD=$password" \
        -e "ENABLE_HOST_SSH=$ssh_setup" -e SSH_HOST=192.0.2.1 \
        "${mount_args[@]}" "$IMAGE" >/dev/null
    wait_ready
    docker exec "$name" bash -c '! command -v xfce4-session && ! pgrep -x xfce4-panel'
    backend=x11
    [ "$wayland" != true ] || backend=wayland
    docker exec "$name" grep -q "Starting ChatGPT Community:.*backend=$backend" \
        /config/.cache/chatgpt-community/startup.log
    port="$(docker port "$name" 3001/tcp | sed -n '1s/.*://p')"
    expected_code=200
    [ -z "$password" ] || expected_code=401
    [ "$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' "https://127.0.0.1:$port/")" = "$expected_code" ]
    if [ "$ssh_setup" = true ]; then
        before="$(docker exec "$name" sha256sum /config/.ssh/id_ed25519)"
    else
        docker exec "$name" test ! -e /config/.ssh/id_ed25519
        docker exec "$name" test ! -e /config/.ssh/config
        docker exec "$name" test ! -e /config/workspace/unraid/AGENTS.md
        docker exec "$name" test ! -e /config/workspace/server/AGENTS.md
    fi
    docker exec -u abc "$name" sh -c 'printf "persistence-test\n" > /config/workspace/persistence-test.txt'
    if [ "$scenario" = standard-wayland ]; then
        docker exec -u abc "$name" grep -qx read-only-project /workspace/shared/probe.txt
        if docker exec -u abc "$name" sh -c ': > /workspace/shared/probe.txt' 2>/dev/null; then
            echo 'FAIL: read-only project allowed writes' >&2
            exit 1
        fi
    fi
    # There has been no streaming WebSocket client. The application must stay alive.
    sleep 5
    docker exec "$name" pgrep -x ChatGPT >/dev/null
    initializations="$(docker exec "$name" grep -c 'Codex CLI initialized' \
        /config/.cache/chatgpt-community/startup.log)"
    docker restart "$name" >/dev/null
    # Require a new handshake, not a matching line from the previous process.
    wait_ready "$((initializations + 1))"
    docker exec -u abc "$name" grep -qx persistence-test /config/workspace/persistence-test.txt
    if [ "$ssh_setup" = true ]; then
        after="$(docker exec "$name" sha256sum /config/.ssh/id_ed25519)"
        [ "$before" = "$after" ]
    else
        docker exec "$name" test ! -e /config/.ssh/id_ed25519
        docker exec "$name" test ! -e /config/.ssh/config
    fi
    echo "PASS: $scenario; application, optional HTTPS auth, data persistence and SSH opt-in"
    cleanup
    name=''
done
