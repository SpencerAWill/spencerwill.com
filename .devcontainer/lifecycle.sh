#!/usr/bin/env bash
# Single entry point for every dev container lifecycle hook, so the ordering
# and the reason each step lives where it does stay readable in one file.
#
#   on-create      once, at creation, before repo content is finalized
#   update-content at creation and whenever prebuild content refreshes
#   post-create    once, after creation and content are done
#   post-start     every container start (including restarts of an existing one)
#   post-attach    every time a client attaches -- keep this fast
#
# Adapted from the flareling dev container.
set -euo pipefail

STAGE="${1:?usage: lifecycle.sh <on-create|update-content|post-create|post-start|post-attach>}"

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
HISTORY_DIR=/commandhistory
NODE_MODULES=/workspace/node_modules
PULUMI_DIR="$HOME/.pulumi"
ZSHRC="$HOME/.zshrc"
MARKER="# >>> devcontainer history <<<"

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$STAGE" "$*"; }

# The image seeds most volumes with dev ownership, but a volume created by an
# older revision of this config can still be root-owned. node_modules always
# needs this on first create: it mounts under the /workspace bind mount, so the
# image cannot pre-create it, and on-create runs before update-content's pnpm
# install. Cheap and idempotent: `-O` skips anything already owned by dev.
claim_volumes() {
  local d
  for d in "$CLAUDE_DIR" "$HISTORY_DIR" "$NODE_MODULES" "$PULUMI_DIR"; do
    [ -d "$d" ] || continue
    [ -O "$d" ] && continue
    log "claiming $d"
    sudo -n chown -R "$(id -u):$(id -g)" "$d" || log "WARN: could not chown $d"
  done
}

# Git identity is not inherited here, and that surprises people. VS Code's Dev
# Containers extension copies the host ~/.gitconfig in automatically
# (dev.containers.copyGitConfig, on by default), but that is a behavior of that
# extension, not of the dev container spec -- Zed implements no equivalent. So
# under Zed the container comes up with no user.name/user.email and every commit
# aborts with "Author identity unknown".
#
# Deriving it from the gh credentials already bind-mounted at ~/.config/gh is
# preferable to bind-mounting the host .gitconfig, which would drag in macOS-only
# settings -- credential.helper=osxkeychain, signing keys pointing at host paths,
# commit.gpgsign -- that are broken or absent in here.
#
# Guarded on user.email being unset, so a manual `git config --global` always
# wins and the gh API call only happens when there is nothing to fall back on.
configure_git() {
  if ! git config --global user.email >/dev/null 2>&1; then
    if gh auth status >/dev/null 2>&1; then
      local login name email id
      login=$(gh api user --jq '.login' 2>/dev/null || true)
      name=$(gh api user --jq '.name // .login' 2>/dev/null || true)
      email=$(gh api user --jq '.email' 2>/dev/null || true)

      # A profile that keeps its address private reports null; GitHub expects
      # commits to carry the noreply form in that case.
      if [ -z "$email" ] || [ "$email" = "null" ]; then
        id=$(gh api user --jq '.id' 2>/dev/null || true)
        if [ -n "$id" ] && [ -n "$login" ]; then
          email="${id}+${login}@users.noreply.github.com"
        fi
      fi

      if [ -n "$name" ] && [ -n "$email" ] && [ "$name" != "null" ]; then
        log "git identity $name <$email> (derived from gh)"
        git config --global user.name "$name"
        git config --global user.email "$email"
      else
        log "WARN: could not derive a git identity from gh -- commits will fail"
      fi
    else
      log "WARN: no git identity and gh is not authenticated -- commits will fail"
    fi
  fi

  # gh holds a token but does not wire itself into git unless asked, so https
  # pushes would otherwise prompt for a password that does not exist.
  if ! git config --global --get-regexp '^credential\..*github\.com.*\.helper' >/dev/null 2>&1; then
    if gh auth status >/dev/null 2>&1; then
      log "configuring gh as the git credential helper"
      gh auth setup-git 2>/dev/null || log "WARN: gh auth setup-git failed"
    fi
  fi

  # Background gc repacks the object store and takes the same locks that
  # commits and the editor's git integration compete for, which is already a
  # tight race under Zed (see .husky/pre-commit). Run `git gc` by hand instead.
  git config --global gc.auto 0
}

on_create() {
  claim_volumes

  # Sizes and setopts only; HISTFILE itself is handled by the symlinks baked
  # into the image, which no .rc file can override.
  if ! grep -qF "$MARKER" "$ZSHRC" 2>/dev/null; then
    log "configuring zsh history"
    cat >>"$ZSHRC" <<'ZRC'

# >>> devcontainer history <<<
HISTSIZE=100000
SAVEHIST=100000
setopt APPEND_HISTORY INC_APPEND_HISTORY SHARE_HISTORY HIST_IGNORE_DUPS
ZRC
  fi

  # The workspace is a bind mount from macOS; uid mapping can make git call it
  # "dubious ownership" and refuse to run.
  git config --global --add safe.directory "$PWD" 2>/dev/null || true

  configure_git
}

update_content() {
  if [ -f pnpm-lock.yaml ]; then
    log "pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile
  elif [ -f package.json ]; then
    log "pnpm install (no lockfile yet)"
    pnpm install
  else
    log "no package.json yet -- skipping dependency install"
    return 0
  fi
}

post_create() {
  log "node    $(node --version)"
  log "pnpm    $(pnpm --version)  (store: $(pnpm store path 2>/dev/null || echo '?'))"
  log "pulumi  $(pulumi version 2>/dev/null || echo 'not on PATH')"
  log "gh      $(gh --version | head -1 | awk '{print $3}')"
  log "claude  $(claude --version 2>/dev/null || echo 'not on PATH')"

  if gh auth status >/dev/null 2>&1; then
    log "gh authenticated as $(gh api user --jq .login 2>/dev/null || echo '?')"
  else
    log "gh not authenticated -- run 'gh auth login' (host: use --insecure-storage)"
  fi
}

post_start() {
  claim_volumes
  configure_git
}

post_attach() {
  log "workspace $PWD -- pulumi $(pulumi whoami 2>/dev/null || echo 'not logged in: run pulumi login')"
}

case "$STAGE" in
  on-create)      on_create ;;
  update-content) update_content ;;
  post-create)    post_create ;;
  post-start)     post_start ;;
  post-attach)    post_attach ;;
  *) echo "unknown stage: $STAGE" >&2; exit 64 ;;
esac
