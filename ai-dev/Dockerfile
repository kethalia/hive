FROM ubuntu:24.04

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

# Add Docker's official GPG key
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc

# Add Docker repository
RUN echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install all packages in a single layer
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
        postgresql-16 \
        postgresql-contrib-16 \
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

# Setup docker-compose symlink
RUN systemctl enable docker
RUN ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/bin/docker-compose

# Setup locale
RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Create coder user with proper groups
RUN userdel -r ubuntu \
    && useradd coder \
        --create-home \
        --shell=/bin/zsh \
        --groups=docker \
        --uid=1000 \
        --user-group \
    && echo "coder ALL=(ALL) NOPASSWD:ALL" >>/etc/sudoers.d/nopasswd

USER coder
WORKDIR /home/coder

# Create common directories
RUN mkdir -p ~/projects ~/bin ~/.config ~/.ssh ~/.local/bin

# Setup basic git configuration that can be overridden
RUN git config --global init.defaultBranch main \
    && git config --global pull.rebase false \
    && git config --global core.editor vim

# Add helpful aliases and shell config to .zshrc
RUN echo '' >> ~/.zshrc \
    && echo '# Custom aliases' >> ~/.zshrc \
    && echo 'alias d="docker"' >> ~/.zshrc \
    && echo 'alias dc="docker-compose"' >> ~/.zshrc \
    && echo 'alias g="git"' >> ~/.zshrc \
    && echo 'alias gs="git status"' >> ~/.zshrc \
    && echo 'alias gp="git pull"' >> ~/.zshrc \
    && echo 'alias gc="git commit"' >> ~/.zshrc \
    && echo 'alias gco="git checkout"' >> ~/.zshrc \
    && echo 'alias ll="ls -lah"' >> ~/.zshrc \
    && echo 'alias k="kubectl"' >> ~/.zshrc \
    && echo '' >> ~/.zshrc \
    && echo '# Add local bin to PATH' >> ~/.zshrc \
    && echo 'export PATH="$HOME/.local/bin:$HOME/bin:$PATH"' >> ~/.zshrc \
    && echo '' >> ~/.zshrc \
    && echo '# Direnv hook' >> ~/.zshrc \
    && echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc \
    && echo '' >> ~/.zshrc \
    && echo '# Starship prompt' >> ~/.zshrc \
    && echo 'eval "$(starship init zsh)"' >> ~/.zshrc

# Add PostgreSQL client configuration
RUN echo 'export PGHOST=localhost' >> ~/.zshrc \
    && echo 'export PGUSER=coder' >> ~/.zshrc \
    && echo 'export PGDATABASE=coder' >> ~/.zshrc

# Add PATH to .bashrc so bash -l commands (coder_app) can find tools
RUN echo 'export PATH="$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.local/share/pnpm:$HOME/.bun/bin:$HOME/.foundry/bin:$PATH"' >> ~/.bashrc
