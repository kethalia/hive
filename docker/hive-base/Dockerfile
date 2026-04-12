FROM debian:trixie

ENV DEBIAN_FRONTEND=noninteractive

# ── Stage 1: system packages (all run as root) ────────────────────────────────

# Base system update
RUN apt-get update \
    && apt-get upgrade --yes --no-install-recommends \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Docker apt repo
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
        -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
        $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        | tee /etc/apt/sources.list.d/docker.list > /dev/null

# NodeSource apt repo (signed key — avoids curl|bash installer)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && chmod a+r /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list

# Google Chrome apt repo
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && chmod a+r /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list

# Install all apt packages in one layer
# Note: trixie ships postgresql 17 natively — no version suffix needed
# Note: software-properties-common was removed from Debian trixie
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        apt-utils \
        bash \
        build-essential \
        containerd.io \
        direnv \
        docker-ce \
        docker-ce-cli \
        docker-buildx-plugin \
        docker-compose-plugin \
        fonts-firacode \
        fonts-liberation \
        fonts-noto-color-emoji \
        fonts-powerline \
        git \
        google-chrome-stable \
        htop \
        jq \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libnss3 \
        locales \
        man \
        nano \
        nodejs \
        openbox \
        openssh-client \
        postgresql \
        postgresql-contrib \
        python3 \
        python3-pip \
        rsync \
        sudo \
        tmux \
        unzip \
        vim \
        wget \
        xterm \
        zsh \
    && corepack enable \
    && rm -rf /var/lib/apt/lists/*

# KasmVNC (trixie-specific .deb — separate apt-get update needed after Chrome repo add)
RUN curl -fsSL -o /tmp/kasmvnc.deb \
        https://github.com/kasmtech/KasmVNC/releases/download/v1.4.0/kasmvncserver_trixie_1.4.0_amd64.deb \
    && apt-get update \
    && apt-get install --yes /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb \
    && rm -rf /var/lib/apt/lists/*

# Obsidian v1.12.7 (pinned — Electron app, installs to /usr/bin/obsidian)
RUN curl -fsSL -o /tmp/obsidian.deb \
        https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/obsidian_1.12.7_amd64.deb \
    && apt-get update \
    && apt-get install --yes /tmp/obsidian.deb \
    && rm -f /tmp/obsidian.deb \
    && rm -rf /var/lib/apt/lists/*

# notesmd-cli v0.3.4 pre-built binary → /usr/local/bin (available to all users)
RUN wget -qO /tmp/notesmd-cli.tar.gz \
        https://github.com/Yakitrak/notesmd-cli/releases/download/v0.3.4/notesmd-cli_0.3.4_linux_amd64.tar.gz \
    && tar xf /tmp/notesmd-cli.tar.gz -C /usr/local/bin notesmd-cli \
    && chmod +x /usr/local/bin/notesmd-cli \
    && rm -f /tmp/notesmd-cli.tar.gz

# act v0.2.74 (pinned) → /usr/local/bin
ENV ACT_VERSION=0.2.74
RUN wget -qO /tmp/act.tar.gz \
        https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_x86_64.tar.gz \
    && tar xf /tmp/act.tar.gz -C /usr/local/bin act \
    && chmod +x /usr/local/bin/act \
    && rm -f /tmp/act.tar.gz

# docker-compose symlink
RUN ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/bin/docker-compose

# Locale — uncomment en_US.UTF-8 in /etc/locale.gen before generating
# (Debian comments it out by default; locale-gen is a no-op without this)
RUN sed -i 's/^# *\(en_US.UTF-8 UTF-8\)$/\1/' /etc/locale.gen \
    && locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Openbox config at /etc/xdg/ — system-wide, survives /home/coder volume mounts
# Each heredoc must be its own RUN: chaining with && causes a Dockerfile parse
# error because the line after the closing delimiter is treated as a new instruction.
RUN mkdir -p /etc/xdg/openbox

# Obsidian launcher script — kept for manual debugging; NOT called from autostart.
# Normal launch path: /etc/xdg/openbox/autostart (baked from docker/hive-base/openbox-autostart).
RUN mkdir -p /usr/local/bin && cat > /usr/local/bin/obsidian-launch << 'XDGEOF'
#!/bin/bash
# Manual Obsidian launcher — useful for debugging.
# In normal operation, /etc/xdg/openbox/autostart (baked from
# docker/hive-base/openbox-autostart) launches Obsidian automatically after
# openbox starts.  This script is kept for manual use only.
LAUNCH_LOG="$HOME/.local/share/browser-vision/obsidian-launch.log"
mkdir -p "$(dirname "$LAUNCH_LOG")"
exec >> "$LAUNCH_LOG" 2>&1
echo "obsidian-launch started at $(date), DISPLAY=$DISPLAY"

i=0
while [ "$i" -lt 60 ]; do
  if [ -d /home/coder/vault/.obsidian ] || [ -d /home/coder/vault/.git ]; then
    echo "Vault ready after ${i}s"
    break
  fi
  sleep 1
  i=$((i + 1))
done

mkdir -p "$HOME/.config/obsidian"
python3 - << 'PYEOF' || echo "WARNING: vault registration failed"
import json, os, time, hashlib
cfg_path = os.path.expanduser('~/.config/obsidian/obsidian.json')
try:
    cfg = json.load(open(cfg_path))
except (OSError, json.JSONDecodeError):
    cfg = {}
vaults = cfg.get('vaults', {})
vault_id = hashlib.md5(b'/home/coder/vault').hexdigest()[:16]
vaults[vault_id] = {'path': '/home/coder/vault', 'ts': int(time.time() * 1000), 'open': True}
cfg['vaults'] = vaults
cfg.pop('cli', None)
json.dump(cfg, open(cfg_path, 'w'))
print('Vault registered:', vault_id)
PYEOF

# Remove any stale Electron single-instance lock left by a prior crash
rm -f "$HOME/.config/obsidian/.lock" 2>/dev/null || true

echo "Launching Obsidian..."
exec /usr/bin/obsidian \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  /home/coder/vault
XDGEOF
RUN chmod +x /usr/local/bin/obsidian-launch

# Openbox config — all three files are tracked as standalone source files
# and copied into the image. No inline heredocs needed.
RUN mkdir -p /var/lib/openbox
COPY openbox-debian-menu.xml /var/lib/openbox/debian-menu.xml
COPY openbox-autostart       /etc/xdg/openbox/autostart
COPY openbox-menu.xml        /etc/xdg/openbox/menu.xml
RUN chmod 755 /etc/xdg/openbox/autostart && chmod 644 /var/lib/openbox/debian-menu.xml /etc/xdg/openbox/menu.xml

# Create coder user
# ssl-cert group is REQUIRED for KasmVNC (TLS cert access)
RUN (id ubuntu && userdel -r ubuntu || true) \
    && useradd coder \
        --create-home \
        --shell=/bin/zsh \
        --groups=docker,ssl-cert \
        --uid=1000 \
        --user-group \
    && echo "coder ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/nopasswd \
    && chmod 0440 /etc/sudoers.d/nopasswd

# ── Stage 2: user-scoped installs (run as coder) ──────────────────────────────

USER coder
WORKDIR /home/coder

# Claude CLI — installed as coder so it lands in ~/.local/bin/claude (user-owned)
# ENV PATH picks it up for non-interactive contexts (docker run, coder_script)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/coder/.local/bin:${PATH}"

ENV NOTESMD_DEFAULT_VAULT=/home/coder/vault

# Common directories
RUN mkdir -p ~/projects ~/bin ~/.config ~/.ssh ~/.local/bin ~/vault

# Seed obsidian.json so vault registration in obsidian-launch has a valid file to update.
# Do NOT set "cli": true — that suppresses the GUI window.
RUN mkdir -p ~/.config/obsidian \
    && echo '{}' > ~/.config/obsidian/obsidian.json

# Git defaults
RUN git config --global init.defaultBranch main \
    && git config --global pull.rebase false \
    && git config --global core.editor vim

# .zshenv — sourced by all zsh invocations (interactive, non-interactive, login, non-login)
# Keeps PATH correct even after Oh My Zsh overwrites .zshrc
RUN echo 'export PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/bin:$PATH"' >> ~/.zshenv \
    && echo 'export PGHOST=localhost' >> ~/.zshenv \
    && echo 'export PGUSER=coder' >> ~/.zshenv \
    && echo 'export PGDATABASE=coder' >> ~/.zshenv

# .bashrc / .profile for bash -l contexts (coder_app launchers)
RUN echo 'export PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"' >> ~/.bashrc \
    && echo 'export PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"' >> ~/.profile
