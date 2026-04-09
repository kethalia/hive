FROM debian:trixie

ENV DEBIAN_FRONTEND=noninteractive

# Base system update
RUN apt-get update \
    && apt-get upgrade --yes --no-install-recommends \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Add Docker's official GPG key (Debian variant)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
        -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc

# Add Docker repository (linux/debian, resolves VERSION_CODENAME to trixie)
RUN echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install all packages in a single layer
# Note: trixie ships postgresql 17 natively — no version suffix needed
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
        fonts-powerline \
        git \
        htop \
        jq \
        locales \
        man \
        nano \
        openssh-client \
        postgresql \
        postgresql-contrib \
        python3 \
        python3-pip \
        rsync \
        software-properties-common \
        sudo \
        tmux \
        unzip \
        vim \
        wget \
        zsh \
    && rm -rf /var/lib/apt/lists/*

# Add Google Chrome apt repo
RUN curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list

# Google Chrome, KasmVNC (trixie build), Openbox, fonts
# Note: openbox is used as the window manager (lightweight X11 WM, supported by KasmVNC)
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        google-chrome-stable \
        fonts-liberation \
        fonts-noto-color-emoji \
        openbox \
        xterm \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
    && curl -fsSL -o /tmp/kasmvnc.deb \
        https://github.com/kasmtech/KasmVNC/releases/download/v1.4.0/kasmvncserver_trixie_1.4.0_amd64.deb \
    && apt-get install --yes /tmp/kasmvnc.deb \
    && rm -f /tmp/kasmvnc.deb \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 24 via NodeSource (always available, no nvm dependency)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Install Claude CLI
# MUST use bash, not sh — dash cannot parse the installer
RUN curl -fsSL https://claude.ai/install.sh | bash

# Install Obsidian (latest release) and its Electron dependencies
# obsidian_1.12.7_amd64.deb — pinned to latest confirmed release tag v1.12.7
RUN curl -fsSL -o /tmp/obsidian.deb \
        https://github.com/obsidianmd/obsidian-releases/releases/download/v1.12.7/obsidian_1.12.7_amd64.deb \
    && apt-get update \
    && apt-get install --yes -f /tmp/obsidian.deb \
    && rm -f /tmp/obsidian.deb \
    && rm -rf /var/lib/apt/lists/*

# Install notesmd-cli v0.3.4 pre-built binary (linux/amd64)
ENV NOTESMD_DEFAULT_VAULT=/home/coder/vault
RUN wget -qO /tmp/notesmd-cli.tar.gz \
        https://github.com/Yakitrak/notesmd-cli/releases/download/v0.3.4/notesmd-cli_0.3.4_linux_amd64.tar.gz \
    && tar xf /tmp/notesmd-cli.tar.gz -C /usr/local/bin notesmd-cli \
    && chmod +x /usr/local/bin/notesmd-cli \
    && rm -f /tmp/notesmd-cli.tar.gz

# Install act (run GitHub Actions locally)
RUN wget -qO /tmp/act.tar.gz \
        https://github.com/nektos/act/releases/latest/download/act_Linux_x86_64.tar.gz \
    && tar xf /tmp/act.tar.gz -C /usr/local/bin act \
    && chmod +x /usr/local/bin/act \
    && rm -f /tmp/act.tar.gz

# Setup docker-compose symlink
RUN systemctl enable docker || true
RUN ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/bin/docker-compose

# Setup locale
RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Bake Openbox desktop config (system-wide — survives volume mounts on /home/coder)
RUN mkdir -p /etc/xdg/openbox \
    && cat > /etc/xdg/openbox/autostart << 'XDGEOF'
# Autostart Obsidian with vault
/usr/bin/obsidian --no-sandbox --disable-gpu-sandbox /home/coder/vault &
XDGEOF
    && cat > /etc/xdg/openbox/menu.xml << 'XDGEOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="Desktop">
    <item label="Obsidian">
      <action name="Execute">
        <command>/usr/bin/obsidian --no-sandbox --disable-gpu-sandbox /home/coder/vault</command>
      </action>
    </item>
    <item label="Terminal">
      <action name="Execute">
        <command>xterm</command>
      </action>
    </item>
  </menu>
</openbox_menu>
XDGEOF
    && chmod 644 /etc/xdg/openbox/autostart /etc/xdg/openbox/menu.xml

# Create coder user with proper groups
# ssl-cert group is REQUIRED for KasmVNC (TLS cert access)
RUN (id ubuntu && userdel -r ubuntu || true) \
    && useradd coder \
        --create-home \
        --shell=/bin/zsh \
        --groups=docker,ssl-cert \
        --uid=1000 \
        --user-group \
    && echo "coder ALL=(ALL) NOPASSWD:ALL" >>/etc/sudoers.d/nopasswd

USER coder
WORKDIR /home/coder

# Create common directories including vault for notesmd-cli
RUN mkdir -p ~/projects ~/bin ~/.config ~/.ssh ~/.local/bin ~/vault

# Setup Obsidian CLI mode (headless)
RUN mkdir -p ~/.config/obsidian \
    && echo '{"cli": true}' > ~/.config/obsidian/obsidian.json

# Setup basic git configuration that can be overridden
RUN git config --global init.defaultBranch main \
    && git config --global pull.rebase false \
    && git config --global core.editor vim

# Setup .zshenv for PATH and env vars (survives Oh My Zsh .zshrc replacement)
# .zshenv is sourced by ALL zsh invocations (interactive, non-interactive, login, non-login)
RUN echo '# Tool PATH (set in .zshenv so it survives Oh My Zsh .zshrc replacement)' > ~/.zshenv \
    && echo 'export PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/bin:$PATH"' >> ~/.zshenv \
    && echo '' >> ~/.zshenv \
    && echo '# PostgreSQL' >> ~/.zshenv \
    && echo 'export PGHOST=localhost' >> ~/.zshenv \
    && echo 'export PGUSER=coder' >> ~/.zshenv \
    && echo 'export PGDATABASE=coder' >> ~/.zshenv

# Add PATH to .bashrc and .profile for bash -l commands (coder_app launchers)
RUN TOOL_PATH='export PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"' \
    && echo "$TOOL_PATH" >> ~/.bashrc \
    && echo "$TOOL_PATH" >> ~/.profile
