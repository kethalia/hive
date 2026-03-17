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

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install --yes --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install act (run GitHub Actions locally)
RUN wget -qO /tmp/act.tar.gz https://github.com/nektos/act/releases/latest/download/act_Linux_x86_64.tar.gz \
    && tar xf /tmp/act.tar.gz -C /usr/local/bin act \
    && rm /tmp/act.tar.gz

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
RUN mkdir -p ~/projects ~/bin ~/.config ~/.ssh

# Setup basic git configuration that can be overridden
RUN git config --global init.defaultBranch main \
    && git config --global pull.rebase false \
    && git config --global core.editor vim

# Add helpful aliases to .zshrc (will be there when Oh My Zsh is installed)
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
    && echo '' >> ~/.zshrc \
    && echo '# Add local bin to PATH' >> ~/.zshrc \
    && echo 'export PATH="$HOME/.local/bin:$HOME/bin:$PATH"' >> ~/.zshrc

# Add PostgreSQL client configuration
RUN echo 'export PGHOST=localhost' >> ~/.zshrc \
    && echo 'export PGUSER=coder' >> ~/.zshrc \
    && echo 'export PGDATABASE=coder' >> ~/.zshrc
