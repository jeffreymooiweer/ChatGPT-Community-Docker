# syntax=docker/dockerfile:1.7

FROM node:22-bookworm AS builder

ARG WRAPPER_SHA
ARG OFFICIAL_VERSION
ARG OFFICIAL_PATH
ARG OFFICIAL_SHA256

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl dpkg-dev g++ gcc git gnupg gpgv \
        make pkg-config python3 tar unzip util-linux xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN test -n "${WRAPPER_SHA}" && test -n "${OFFICIAL_VERSION}" \
    && test -n "${OFFICIAL_PATH}" && test -n "${OFFICIAL_SHA256}"

WORKDIR /src
RUN git init . \
    && git remote add origin https://github.com/ilysenko/codex-desktop-linux.git \
    && git fetch --depth=1 origin "${WRAPPER_SHA}" \
    && git checkout --detach FETCH_HEAD

COPY tests/remote-control-visibility.test.cjs /tmp/unraid-tests/remote-control-visibility.test.cjs
# Upstream now discovers this function semantically across webview assets.
# Verify the contract and access restrictions without an obsolete filename patch.
RUN UPSTREAM_SOURCE=/src node --test /tmp/unraid-tests/remote-control-visibility.test.cjs \
    && node --test linux-features/remote-mobile-control/test.js

RUN printf '%s\n' '{"enabled":["remote-mobile-control"]}' \
    > linux-features/features.json

RUN curl --fail --location --retry 3 \
        "https://persistent.oaistatic.com/codex-app-prod/linux/deb/${OFFICIAL_PATH}" \
        -o /tmp/chatgpt.deb \
    && echo "${OFFICIAL_SHA256}  /tmp/chatgpt.deb" | sha256sum -c - \
    && test "$(dpkg-deb -f /tmp/chatgpt.deb Version)" = "${OFFICIAL_VERSION}" \
    && test "$(dpkg-deb -f /tmp/chatgpt.deb Architecture)" = amd64

RUN UPSTREAM_DEB=/tmp/chatgpt.deb make build-app \
    && PACKAGE_WITH_UPDATER=0 PACKAGE_VERSION="${OFFICIAL_VERSION}" make deb

FROM ghcr.io/linuxserver/baseimage-selkies:debiantrixie

# Single-application session. No XFCE, desktop shell, taskbar or start menu.
# AUTO_GPU selects rendering and encoding devices when /dev/dri is passed in.
ENV TITLE="ChatGPT Community" \
    ENABLE_HOST_SSH=false \
    PIXELFLUX_WAYLAND=true \
    AUTO_GPU=true \
    SELKIES_DESKTOP=false \
    NO_DECOR=true \
    NO_GAMEPAD=true \
    DISABLE_MOUSE_BUTTONS=true \
    HARDEN_KEYBINDS=true \
    RESTART_APP=false \
    SELKIES_FRAMERATE=30 \
    SELKIES_H264_FULLCOLOR="false|locked" \
    SELKIES_SECOND_SCREEN="false|locked" \
    SELKIES_ENABLE_SHARING="false|locked" \
    SELKIES_COMMAND_ENABLED="false|locked" \
    SELKIES_UI_SHOW_SIDEBAR=false \
    SELKIES_UI_SHOW_LOGO=false \
    SELKIES_UI_SHOW_CORE_BUTTONS=false \
    SELKIES_UI_TITLE="ChatGPT Community" \
    MAX_RES=3840x2160 \
    CODEX_LINUX_DISABLE_USAGE_REPORTING=1 \
    CODEX_OZONE_PLATFORM=auto

# Chromium is only an auxiliary browser for sign-in and external links.
# Keep Secret Service support; never force a different credential backend.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates chromium curl dbus-x11 git gnome-keyring \
        iputils-ping jq libsecret-1-0 openssh-client procps rsync \
        util-linux vainfo xdg-utils \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /src/dist/*.deb /tmp/codex-desktop.deb
RUN apt-get update \
    && apt-get install -y /tmp/codex-desktop.deb \
    && rm -f /tmp/codex-desktop.deb \
    && rm -rf /var/lib/apt/lists/*

COPY root/ /
RUN chmod 0755 /custom-cont-init.d/10-chatgpt-unraid.sh \
        /usr/local/bin/start-chatgpt-community \
        /usr/local/bin/chatgpt-browser \
        /defaults/autostart /defaults/autostart_wayland \
    && cp /opt/codex-desktop/resources/icon-chatgpt.png \
        /usr/share/selkies/www/icon.png \
    && /usr/bin/codex-desktop --diagnose

EXPOSE 3001
VOLUME /config
