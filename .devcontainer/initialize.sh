#!/usr/bin/env bash
# Runs on the HOST, before the container is created or started, so it can only
# assume host tools, not anything from the image.
#
# Sole job: guarantee the bind-mount source for the container's gh config
# exists. Docker invents a missing bind source as a root-owned directory, which
# then can't be written from inside the container.
#
# This is a script rather than an inline command because the string form of
# initializeCommand is not portably shell-interpreted: Zed splits it on
# whitespace and execs it directly, so an inline `mkdir -p "$HOME/.config/gh"`
# creates a literal directory named `"$HOME` in the repo root instead.
set -euo pipefail

mkdir -p "$HOME/.config/gh"
