#!/bin/bash
set -e

BOLD='\033[0;1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RESET='\033[0m'

command_exists() {
  command -v "$1" &> /dev/null
}

install_if_missing() {
  local name=$1
  local check_cmd=$2
  local check_path=$3
  local install_cmd=$4

  if [ -n "$check_cmd" ] && command_exists "$check_cmd"; then
    printf "${GREEN}[ok] %s already installed${RESET}\n" "$name"
    return 0
  elif [ -n "$check_path" ] && [ -e "$check_path" ]; then
    printf "${GREEN}[ok] %s already installed${RESET}\n" "$name"
    return 0
  fi

  printf "${BOLD}[install] %s...${RESET}\n" "$name"
  if eval "$install_cmd"; then
    printf "${GREEN}[ok] %s installed successfully${RESET}\n\n" "$name"
  else
    printf "${YELLOW}[warn] %s installation failed, continuing...${RESET}\n\n" "$name"
  fi
}

# Install Oh My Zsh (without powerlevel10k — we use Starship)
# shellcheck disable=SC2016 # Commands are intentionally evaluated by install_if_missing.
install_if_missing "Oh My Zsh" "" "$HOME/.oh-my-zsh/.hive-install-complete" '
  if [ ! -f "$HOME/.oh-my-zsh/oh-my-zsh.sh" ]; then
    rm -rf "$HOME/.oh-my-zsh" &&
    RUNZSH=no CHSH=no sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
  fi &&
  for plugin in zsh-autosuggestions zsh-syntax-highlighting zsh-completions; do
    destination="$HOME/.oh-my-zsh/custom/plugins/$plugin"
    if [ ! -d "$destination/.git" ]; then
      rm -rf "$destination"
      git clone --quiet "https://github.com/zsh-users/$plugin.git" "$destination" || exit 1
    fi
  done &&
  sed -i "s|^ZSH_THEME.*|ZSH_THEME=\"\"|g" "$HOME/.zshrc" &&
  sed -i "s|^plugins=.*|plugins=(git zsh-autosuggestions zsh-syntax-highlighting zsh-completions direnv tmux)|g" "$HOME/.zshrc" &&
  touch "$HOME/.oh-my-zsh/.hive-install-complete"
'

# Install Starship prompt
# shellcheck disable=SC2016 # Commands are intentionally evaluated by install_if_missing.
install_if_missing "Starship" "starship" "" '
  curl -sS https://starship.rs/install.sh | sh -s -- --yes --bin-dir "$HOME/.local/bin"
'

# Configure Starship — hide [Docker] container indicator
mkdir -p "$HOME/.config"
if [ ! -f "$HOME/.config/starship.toml" ]; then
  cat > "$HOME/.config/starship.toml" << 'STARSHIPEOF'
[container]
disabled = true
STARSHIPEOF
fi

# Append shell config only if not already present (idempotency guard)
if ! grep -q '# Custom aliases' "$HOME/.zshrc" 2>/dev/null; then
  cat >> "$HOME/.zshrc" << 'ZSHEOF'

# Custom aliases
alias g="git"
alias gs="git status"
alias gp="git pull"
alias gc="git commit"
alias gco="git checkout"
alias ll="ls -lah"
alias chrome="DISPLAY=:1 google-chrome-stable --no-sandbox"

# Direnv hook
eval "$(direnv hook zsh)"

# Starship prompt
eval "$(starship init zsh)"
ZSHEOF
fi

exit 0
