FROM debian:trixie

ARG WORKSPACE_VARIANT=cli

ENV DEBIAN_FRONTEND=noninteractive
ENV HIVE_IMAGE_VARIANT=${WORKSPACE_VARIANT}

# One Dockerfile produces five intentionally narrow Kubernetes workspace images:
#   cli           - Codex, Claude Code, and common command-line development tools
#   infrastructure - cli + Terraform, kubectl, Helm, and Argo CD clients
#   game          - cli + XFCE/KasmVNC + Unity Hub + Blender
#   electronics   - cli + XFCE/KasmVNC + KiCad
#   browser       - cli + XFCE/KasmVNC + Google Chrome
RUN case "$WORKSPACE_VARIANT" in \
      cli|infrastructure|game|electronics|browser) ;; \
      *) printf 'Unsupported WORKSPACE_VARIANT: %s\n' "$WORKSPACE_VARIANT" >&2; exit 1 ;; \
    esac

# ── Common CLI image ─────────────────────────────────────────────────────────

RUN apt-get update \
    && apt-get upgrade --yes --no-install-recommends \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        lsb-release \
    && rm -rf /var/lib/apt/lists/*

# Docker apt repository. Workspaces get the client/toolchain, never a host socket.
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
        -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
        $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list

# NodeSource apt repository (signed key; avoids the curl|bash installer).
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && chmod a+r /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list

# Note: Debian trixie ships PostgreSQL 17 natively.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        apt-utils \
        bash \
        build-essential \
        direnv \
        docker-buildx-plugin \
        docker-ce-cli \
        docker-compose-plugin \
        fonts-firacode \
        fonts-powerline \
        git \
        htop \
        jq \
        locales \
        man \
        nano \
        nodejs \
        openssh-client \
        postgresql \
        postgresql-contrib \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        rsync \
        sqlite3 \
        sudo \
        tmux \
        unzip \
        vim \
        zsh \
    && corepack enable \
    && rm -rf /var/lib/apt/lists/*

# notesmd-cli v0.3.4 pre-built binary -> /usr/local/bin.
RUN curl -fsSLo /tmp/notesmd-cli.tar.gz \
        https://github.com/Yakitrak/notesmd-cli/releases/download/v0.3.4/notesmd-cli_0.3.4_linux_amd64.tar.gz \
    && tar xf /tmp/notesmd-cli.tar.gz -C /usr/local/bin notesmd-cli \
    && chmod +x /usr/local/bin/notesmd-cli \
    && rm -f /tmp/notesmd-cli.tar.gz

# act v0.2.74 pre-built binary -> /usr/local/bin.
ENV ACT_VERSION=0.2.74
RUN curl -fsSLo /tmp/act.tar.gz \
        https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_x86_64.tar.gz \
    && tar xf /tmp/act.tar.gz -C /usr/local/bin act \
    && chmod +x /usr/local/bin/act \
    && rm -f /tmp/act.tar.gz \
    && ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/bin/docker-compose

# tmux session persistence plugins, pinned for reproducible builds.
ARG TMUX_RESURRECT_SHA=e87d7d592cac97fa38c12395ebec042c154a1844
ARG TMUX_CONTINUUM_SHA=46e0e0023476018ddb4cc0d44783eede27e5a8ec
RUN mkdir -p /opt/tmux-plugins \
    && git clone https://github.com/tmux-plugins/tmux-resurrect.git \
        /opt/tmux-plugins/tmux-resurrect \
    && git -C /opt/tmux-plugins/tmux-resurrect checkout "${TMUX_RESURRECT_SHA}" \
    && git clone https://github.com/tmux-plugins/tmux-continuum.git \
        /opt/tmux-plugins/tmux-continuum \
    && git -C /opt/tmux-plugins/tmux-continuum checkout "${TMUX_CONTINUUM_SHA}" \
    && rm -rf /opt/tmux-plugins/*/.git

COPY tmux.conf /etc/tmux.conf

RUN sed -i 's/^# *\(en_US.UTF-8 UTF-8\)$/\1/' /etc/locale.gen \
    && locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# ── Infrastructure capability ───────────────────────────────────────────────

# Versions align with the platform repository where one exists. Every archive
# and standalone binary is verified against its vendor-published SHA-256.
ARG TERRAFORM_VERSION=1.15.8
ARG TERRAFORM_SHA256=d25ce7b6902013ad905db3d2eab0be4cd905887fe88b81a6171b8d5503c31f3d
ARG KUBECTL_VERSION=1.34.5
ARG KUBECTL_SHA256=6a17dd8387783b3144a65535e38d02c351027e9718ea34a6c360476cb26d28bb
ARG HELM_VERSION=3.16.4
ARG HELM_SHA256=fc307327959aa38ed8f9f7e66d45492bb022a66c3e5da6063958254b9767d179
ARG ARGOCD_VERSION=3.3.4
ARG ARGOCD_SHA256=404bb83c90cdb7f8054187966f26b17d99961d48fa01f4d6000fe0608dcf9c2b
RUN if [ "$WORKSPACE_VARIANT" = "infrastructure" ]; then \
      curl -fsSLo /tmp/terraform.zip \
          "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
      && printf '%s  %s\n' "$TERRAFORM_SHA256" /tmp/terraform.zip \
          | sha256sum --check --status \
      && unzip -q /tmp/terraform.zip terraform -d /usr/local/bin \
      && chmod 0755 /usr/local/bin/terraform \
      && curl -fsSLo /tmp/kubectl \
          "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
      && printf '%s  %s\n' "$KUBECTL_SHA256" /tmp/kubectl \
          | sha256sum --check --status \
      && install -m 0755 /tmp/kubectl /usr/local/bin/kubectl \
      && curl -fsSLo /tmp/helm.tar.gz \
          "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" \
      && printf '%s  %s\n' "$HELM_SHA256" /tmp/helm.tar.gz \
          | sha256sum --check --status \
      && tar -xzf /tmp/helm.tar.gz -C /tmp linux-amd64/helm \
      && install -m 0755 /tmp/linux-amd64/helm /usr/local/bin/helm \
      && curl -fsSLo /tmp/argocd \
          "https://github.com/argoproj/argo-cd/releases/download/v${ARGOCD_VERSION}/argocd-linux-amd64" \
      && printf '%s  %s\n' "$ARGOCD_SHA256" /tmp/argocd \
          | sha256sum --check --status \
      && install -m 0755 /tmp/argocd /usr/local/bin/argocd \
      && rm -rf \
          /tmp/argocd \
          /tmp/helm.tar.gz \
          /tmp/kubectl \
          /tmp/linux-amd64 \
          /tmp/terraform.zip; \
    fi

# ── Desktop capability (game, electronics, and browser only) ─────────────────

# hadolint ignore=DL3008
RUN if [ "$WORKSPACE_VARIANT" = "game" ] \
    || [ "$WORKSPACE_VARIANT" = "electronics" ] \
    || [ "$WORKSPACE_VARIANT" = "browser" ]; then \
      apt-get update \
      && apt-get install --yes --no-install-recommends \
          dbus-x11 \
          fonts-liberation \
          fonts-noto-color-emoji \
          libatk-bridge2.0-0 \
          libatspi2.0-0 \
          libgl1 \
          libglu1-mesa \
          libgtk-3-0 \
          libnotify4 \
          libnss3 \
          libsecret-1-0 \
          libvulkan1 \
          libxss1 \
          libxtst6 \
          mesa-utils \
          mesa-vulkan-drivers \
          xdg-utils \
          xfce4 \
          xfce4-session \
          xfce4-terminal \
          xterm \
      && rm -rf /var/lib/apt/lists/* \
      && curl -fsSL -o /tmp/kasmvnc.deb \
          https://github.com/kasmtech/KasmVNC/releases/download/v1.4.0/kasmvncserver_trixie_1.4.0_amd64.deb \
      && apt-get update \
      && apt-get install --yes --no-install-recommends /tmp/kasmvnc.deb \
      && rm -f /tmp/kasmvnc.deb \
      && rm -rf /var/lib/apt/lists/*; \
    fi

COPY xstartup kasmvnc.yaml /tmp/hive-kasmvnc/
RUN if [ "$WORKSPACE_VARIANT" = "game" ] \
    || [ "$WORKSPACE_VARIANT" = "electronics" ] \
    || [ "$WORKSPACE_VARIANT" = "browser" ]; then \
      install -d -m 0755 /etc/kasmvnc \
      && install -m 0755 /tmp/hive-kasmvnc/xstartup /etc/kasmvnc/xstartup \
      && install -m 0644 /tmp/hive-kasmvnc/kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml; \
    fi \
    && rm -rf /tmp/hive-kasmvnc

# ── Game capability ──────────────────────────────────────────────────────────

RUN if [ "$WORKSPACE_VARIANT" = "game" ]; then \
      curl -fsSLo /tmp/unityhub.deb \
          https://hub.unity3d.com/linux/repos/deb/pool/main/u/unity/unityhub_amd64/UnityHubSetup-3.19.5-amd64.deb \
      && printf '%s  %s\n' \
          '5a5b57adc9ce20931c4154c57ffded08f3ffa2743286fdf14c9e7add6b212540' \
          '/tmp/unityhub.deb' | sha256sum --check --status \
      && apt-get update \
      && apt-get install --yes --no-install-recommends /tmp/unityhub.deb \
      && rm -f /tmp/unityhub.deb \
      && rm -rf /var/lib/apt/lists/*; \
    fi

ARG BLENDER_VERSION=4.5.12
RUN if [ "$WORKSPACE_VARIANT" = "game" ]; then \
      curl -fsSLo /tmp/blender.tar.xz \
          "https://download.blender.org/release/Blender4.5/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
      && printf '%s  %s\n' \
          '95e3a2dfedba3bd32ca54fc355eac6b15a11986954ccb02815a07535d0120a25' \
          '/tmp/blender.tar.xz' | sha256sum --check --status \
      && mkdir -p /opt/blender \
      && tar -xJf /tmp/blender.tar.xz --strip-components=1 -C /opt/blender \
      && ln -s /opt/blender/blender /usr/local/bin/blender \
      && rm -f /tmp/blender.tar.xz; \
    fi

COPY unity-hub.desktop blender.desktop /tmp/hive-game-desktop/
RUN if [ "$WORKSPACE_VARIANT" = "game" ]; then \
      install -m 0644 /tmp/hive-game-desktop/unity-hub.desktop /usr/share/applications/unity-hub.desktop \
      && install -m 0644 /tmp/hive-game-desktop/blender.desktop /usr/share/applications/blender.desktop; \
    fi \
    && rm -rf /tmp/hive-game-desktop

# ── Electronics capability ───────────────────────────────────────────────────

# hadolint ignore=DL3008
RUN if [ "$WORKSPACE_VARIANT" = "electronics" ]; then \
      apt-get update \
      && apt-get install --yes --no-install-recommends \
          kicad \
          kicad-libraries \
          kicad-packages3d \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# ── Browser capability ───────────────────────────────────────────────────────

# hadolint ignore=DL3008
RUN if [ "$WORKSPACE_VARIANT" = "browser" ]; then \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
          | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
      && chmod a+r /etc/apt/keyrings/google-chrome.gpg \
      && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
          > /etc/apt/sources.list.d/google-chrome.list \
      && apt-get update \
      && apt-get install --yes --no-install-recommends google-chrome-stable \
      && rm -rf /var/lib/apt/lists/*; \
    fi

COPY google-chrome.desktop /tmp/hive-browser-desktop/
RUN if [ "$WORKSPACE_VARIANT" = "browser" ]; then \
      install -m 0644 /tmp/hive-browser-desktop/google-chrome.desktop /usr/share/applications/google-chrome.desktop; \
    fi \
    && rm -rf /tmp/hive-browser-desktop

# ── Non-root workspace user ──────────────────────────────────────────────────

# The group is present in every variant so the user declaration stays identical;
# only desktop variants install KasmVNC and consume its certificate access.
RUN groupadd --force docker \
    && groupadd --force ssl-cert \
    && (id ubuntu >/dev/null 2>&1 && userdel -r ubuntu || true) \
    && useradd coder \
        --create-home \
        --shell=/bin/zsh \
        --groups=docker,ssl-cert \
        --uid=1000 \
        --user-group \
    && echo "coder ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/nopasswd \
    && chmod 0440 /etc/sudoers.d/nopasswd

USER coder
WORKDIR /home/coder

# Claude Code is image-baked; Codex is installed into the persistent home by
# the profile startup script so updates do not require rebuilding every variant.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/coder/.local/bin:${PATH}"

RUN mkdir -p ~/projects ~/bin ~/.config ~/.ssh ~/.local/bin ~/.claude \
    && git config --global init.defaultBranch main \
    && git config --global pull.rebase false \
    && git config --global core.editor vim

# PATH configuration for zsh, bash login shells, and Coder app launchers.
RUN echo 'export PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/bin:$PATH"' >> ~/.zshenv \
    && echo 'export PGHOST=localhost' >> ~/.zshenv \
    && echo 'export PGUSER=coder' >> ~/.zshenv \
    && echo 'export PGDATABASE=coder' >> ~/.zshenv \
    && echo 'export PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/bin:$PATH"' >> ~/.bashrc \
    && echo 'export PATH="$HOME/.claude/local/bin:$HOME/.local/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$HOME/bin:$PATH"' >> ~/.profile
