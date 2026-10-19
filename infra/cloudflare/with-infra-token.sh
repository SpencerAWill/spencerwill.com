#!/usr/bin/env bash
# Runs a command with CLOUDFLARE_API_TOKEN set, so local Pulumi runs use the
# same scoped write token CI's `deploy` job does instead of a hand-made one.
#
# An explicitly exported CLOUDFLARE_API_TOKEN always wins. Otherwise the token
# is read from the infra/github stack, which mints it (see
# infra/github/src/cloudflare-tokens.ts) and exports it as an encrypted output.
# Nothing is written to disk.
set -euo pipefail

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if ! CLOUDFLARE_API_TOKEN=$(
    pulumi stack output cloudflareWriteToken --show-secrets \
      --cwd "$(dirname "$0")/../github" --stack main 2>/dev/null
  ) || [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "No Cloudflare token: export CLOUDFLARE_API_TOKEN, or apply" >&2
    echo "infra/github with cloudflare:apiToken set so it mints one." >&2
    exit 1
  fi
  export CLOUDFLARE_API_TOKEN
fi

exec "$@"
