#!/bin/bash
#
# Shared helpers for the VM startup scripts. The Pulumi program puts this file
# in front of supabase-studio.sh or outline-vpn.sh, so each VM gets a single
# script in its `startup-script` metadata.
#
# The VMs run Container-Optimized OS: bash, curl, coreutils and Docker are
# there, gcloud and jq are not. Settings come from instance metadata
# attributes; secrets come from Secret Manager's REST API, authenticated as
# the VM's service account. The script runs on every boot.

set -euo pipefail

readonly METADATA_URL="http://metadata.google.internal/computeMetadata/v1"

log() {
  echo "[startup] $*" >&2
}

# Prints the instance metadata attribute $1.
attr() {
  curl -sSf --retry 5 -H "Metadata-Flavor: Google" "${METADATA_URL}/instance/attributes/$1"
}

# Runs "$@" until it succeeds: 30 attempts, 10 seconds apart.
retry() {
  local attempt
  for attempt in $(seq 1 30); do
    if "$@"; then
      return 0
    fi
    log "attempt ${attempt}/30 failed: $1"
    sleep 10
  done
  return 1
}

# Prints the payload of one Secret Manager secret version. $1 is the full
# version name, projects/<number>/secrets/<id>/versions/<n>.
access_secret_version() {
  local token response data
  token="$(curl -sSf -H "Metadata-Flavor: Google" \
    "${METADATA_URL}/instance/service-accounts/default/token" |
    sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')" || return 1
  [ -n "${token}" ] || return 1
  response="$(curl -sSf -H "Authorization: Bearer ${token}" \
    "https://secretmanager.googleapis.com/v1/$1:access")" || return 1
  data="$(printf '%s' "${response}" | tr -d '\n' |
    sed -n 's/.*"data" *: *"\([^"]*\)".*/\1/p')"
  [ -n "${data}" ] || return 1
  printf '%s' "${data}" | base64 -d
}

# Like access_secret_version, with retries: on a new VM the IAM binding that
# lets it read the secret can take a few minutes to apply.
read_secret() {
  retry access_secret_version "$1"
}

wait_for_docker() {
  local attempt
  for attempt in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  log "Docker did not start"
  return 1
}
