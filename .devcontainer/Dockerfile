# syntax=docker/dockerfile:1
# Adapted from the flareling and www.spencerwill.com dev containers.
ARG NODE_VARIANT=24-bookworm
FROM mcr.microsoft.com/devcontainers/javascript-node:${NODE_VARIANT}

ARG USERNAME=dev
ARG OLD_USERNAME=node

# Rename the image's existing uid/gid 1000 user rather than creating a second
# one. The uid never changes, so everything the base image already chowned to
# it (the npm global prefix, oh-my-zsh, nvm) keeps working untouched.
# visudo -c turns a bad sudoers edit into a build failure instead of a
# container you can't sudo in.
RUN set -eux; \
    groupmod -n "${USERNAME}" "${OLD_USERNAME}"; \
    usermod -l "${USERNAME}" -d "/home/${USERNAME}" -m "${OLD_USERNAME}"; \
    mv "/etc/sudoers.d/${OLD_USERNAME}" "/etc/sudoers.d/${USERNAME}"; \
    sed -i "s/^${OLD_USERNAME}\b/${USERNAME}/" "/etc/sudoers.d/${USERNAME}"; \
    chmod 0440 "/etc/sudoers.d/${USERNAME}"; \
    visudo -c -f "/etc/sudoers.d/${USERNAME}"

# pnpm comes from corepack, which reads the exact version pinned in
# package.json's `packageManager` field, so the container and CI always run the
# same pnpm. `corepack enable` installs the shims into /usr/local/bin as root.
RUN corepack enable

# gitleaks for the pre-commit secret scan (.husky/pre-commit). No dev
# container feature verifies the binary it downloads, so it is fetched here from
# the pinned release and checked against the SHA-256 published in that
# release's checksums.txt. CI pins the same version in ci.yml; bump both.
ARG GITLEAKS_VERSION=8.30.1
ARG TARGETARCH
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) asset=linux_x64; sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;; \
      arm64) asset=linux_arm64; sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;; \
      *) echo "no pinned gitleaks checksum for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gitleaks.tar.gz \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${asset}.tar.gz"; \
    echo "${sha}  /tmp/gitleaks.tar.gz" | sha256sum --check --strict; \
    tar xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks; \
    rm /tmp/gitleaks.tar.gz; \
    gitleaks version

# Image-intrinsic env: static values that should apply however the container is
# launched (VS Code, Zed, `docker compose exec`, CI). Per-host values like TZ
# stay in devcontainer.json so they can read ${localEnv:...}.
#
# CLAUDE_CONFIG_DIR matters for persistence: by default Claude Code keeps
# ~/.claude.json (per-project state, MCP servers, onboarding flags) in $HOME,
# outside the .claude directory. Pointing the config dir at .claude pulls that
# file into the named volume with the session transcripts.
#
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0: corepack otherwise asks "Do you want to
# continue?" before downloading the pinned pnpm, which hangs the unattended
# `pnpm install` in update-content.
ENV CLAUDE_CONFIG_DIR=/home/${USERNAME}/.claude \
    PNPM_HOME=/home/${USERNAME}/.local/share/pnpm \
    PATH=/home/${USERNAME}/.local/share/pnpm:${PATH} \
    NODE_OPTIONS=--max-old-space-size=4096 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    DEVCONTAINER=true

# Pre-create volume mount points with correct ownership. Docker seeds a fresh
# named volume from whatever is at its mount point in the image, so this is what
# makes the volumes come up owned by dev instead of root.
#
# chown -R over the parents, not just the leaves: `install -d -o dev` applies
# ownership only to the final component, leaving ~/.local and ~/.local/share
# owned by root. That breaks any tool that later wants its own directory there
# (Zed's remote server creates ~/.local/share/zed/server_state and exits 1 if
# it can't).
RUN mkdir -p \
      "/home/${USERNAME}/.claude" \
      "/home/${USERNAME}/.config/gh" \
      "/home/${USERNAME}/.local/share/pnpm" \
      "/home/${USERNAME}/.pulumi" \
      /commandhistory \
    && chown -R "${USERNAME}:${USERNAME}" \
      "/home/${USERNAME}/.claude" \
      "/home/${USERNAME}/.config" \
      "/home/${USERNAME}/.local" \
      "/home/${USERNAME}/.pulumi" \
      "/home/${USERNAME}/.cache" \
      /commandhistory

# Prompt and completion plugins, pinned to tags. The zsh-plugins feature is not
# used on purpose: it clones each plugin's default branch with no revision
# pinned, which is the one thing worth avoiding given the supply-chain posture
# in pnpm-workspace.yaml. The .git directories are dropped so they do not ride
# along in the image.
RUN git clone --depth 1 --branch v0.7.1 \
      https://github.com/zsh-users/zsh-autosuggestions \
      "/home/${USERNAME}/.oh-my-zsh/custom/plugins/zsh-autosuggestions" \
    && git clone --depth 1 --branch 0.8.0 \
      https://github.com/zsh-users/zsh-syntax-highlighting \
      "/home/${USERNAME}/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting" \
    && rm -rf "/home/${USERNAME}/.oh-my-zsh/custom/plugins/zsh-autosuggestions/.git" \
              "/home/${USERNAME}/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting/.git" \
    && sed -i 's/^plugins=(git)$/plugins=(git gh npm node zsh-interactive-cd zsh-autosuggestions zsh-syntax-highlighting)/' \
      "/home/${USERNAME}/.zshrc" \
    && grep -q 'zsh-syntax-highlighting' "/home/${USERNAME}/.zshrc" \
    && chown -R "${USERNAME}:${USERNAME}" \
      "/home/${USERNAME}/.oh-my-zsh/custom" "/home/${USERNAME}/.zshrc"

# Prompt: Powerlevel10k, pinned, using its shipped `lean` config. That config
# uses ordinary Unicode only, so it renders in Zed's default font. The one edit
# flips POWERLEVEL9K_MODE to ascii so segments that draw from p10k's icon table
# (node version, os icon) do not render as tofu.
#
# gitstatusd is p10k's git backend. Left alone it downloads its own binary on
# the first interactive shell, a surprise network fetch at runtime. It is
# fetched here instead, as the user that will run it, so it ships in the image.
RUN P10K="/home/${USERNAME}/.oh-my-zsh/custom/themes/powerlevel10k" \
    && git clone --depth 1 --branch v1.9.1 \
      https://github.com/romkatv/powerlevel10k "$P10K" \
    && rm -rf "$P10K/.git" \
    && cp "$P10K/config/p10k-lean.zsh" "/home/${USERNAME}/.p10k.zsh" \
    && sed -i 's/^\(\s*\)typeset -g POWERLEVEL9K_MODE=.*/\1typeset -g POWERLEVEL9K_MODE=ascii/' \
      "/home/${USERNAME}/.p10k.zsh" \
    && grep -q 'POWERLEVEL9K_MODE=ascii' "/home/${USERNAME}/.p10k.zsh" \
    && sed -i 's|^ZSH_THEME=.*|ZSH_THEME="powerlevel10k/powerlevel10k"|' \
      "/home/${USERNAME}/.zshrc" \
    && printf '\n# Powerlevel10k prompt configuration.\n[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh\n' \
      >> "/home/${USERNAME}/.zshrc" \
    && su "${USERNAME}" -c "HOME=/home/${USERNAME} $P10K/gitstatus/install -f" \
    && ls "/home/${USERNAME}/.cache/gitstatus/"gitstatusd-* > /dev/null \
    && chown -R "${USERNAME}:${USERNAME}" \
      "/home/${USERNAME}/.oh-my-zsh/custom" "/home/${USERNAME}/.zshrc" \
      "/home/${USERNAME}/.p10k.zsh" "/home/${USERNAME}/.cache"

# Persist bash/zsh history across rebuilds via the /commandhistory volume.
# Symlinks beat a HISTFILE export because they survive any oh-my-zsh or user
# .rc override.
RUN touch /commandhistory/.bash_history /commandhistory/.zsh_history \
    && chown "${USERNAME}:${USERNAME}" /commandhistory/.bash_history /commandhistory/.zsh_history \
    && ln -sfn /commandhistory/.bash_history "/home/${USERNAME}/.bash_history" \
    && ln -sfn /commandhistory/.zsh_history "/home/${USERNAME}/.zsh_history" \
    && chown -h "${USERNAME}:${USERNAME}" \
      "/home/${USERNAME}/.bash_history" "/home/${USERNAME}/.zsh_history"
