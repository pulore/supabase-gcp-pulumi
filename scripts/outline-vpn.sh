#
# Outline VPN server ("shadowbox"). The container settings follow Outline's
# install_server.sh, with three differences: the image tag is pinned (no
# Watchtower), the TLS certificate and API prefix come from Secret Manager,
# and the access-key port is fixed so the VPC firewall can open just that port.

readonly MOUNT_DIR=/mnt/disks/outline
readonly STATE_DIR="${MOUNT_DIR}/persisted-state"

IMAGE="$(attr outline-image)"
API_PORT="$(attr outline-api-port)"
ACCESS_KEY_PORT="$(attr outline-access-key-port)"
PUBLIC_HOSTNAME="$(attr outline-hostname)"
DATA_DEVICE="/dev/disk/by-id/google-$(attr outline-data-disk-device)"

# Outline keeps its access keys and settings on a separate persistent disk, so
# they survive the VM being recreated. Format it the first time only.
if ! mountpoint -q "${MOUNT_DIR}"; then
  retry test -e "${DATA_DEVICE}"
  if ! blkid "${DATA_DEVICE}" >/dev/null 2>&1; then
    log "formatting ${DATA_DEVICE}"
    mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "${DATA_DEVICE}"
  fi
  mkdir -p "${MOUNT_DIR}"
  mount -o discard,defaults "${DATA_DEVICE}" "${MOUNT_DIR}"
fi
mkdir -p "${STATE_DIR}"
chmod 0770 "${STATE_DIR}"

# Writes the secret named by metadata attribute $1 to the file $2.
write_secret_file() {
  read_secret "$(attr "$1")" >"$2.new"
  mv "$2.new" "$2"
}

umask 077
log "reading the management API certificate and prefix from Secret Manager"
write_secret_file outline-tls-cert-secret "${STATE_DIR}/shadowbox-selfsigned.crt"
write_secret_file outline-tls-key-secret "${STATE_DIR}/shadowbox-selfsigned.key"
SB_API_PREFIX="$(read_secret "$(attr outline-api-prefix-secret)")"
export SB_API_PREFIX

# Written once. After that the server owns this file: changes made in Outline
# Manager (server name, hostname, port for new keys) are saved here.
CONFIG_FILE="${STATE_DIR}/shadowbox_server_config.json"
if [ ! -s "${CONFIG_FILE}" ]; then
  printf '{"hostname":"%s","portForNewAccessKeys":%s,"metricsEnabled":false}\n' \
    "${PUBLIC_HOSTNAME}" "${ACCESS_KEY_PORT}" >"${CONFIG_FILE}"
fi

# Container-Optimized OS only accepts SSH by default. shadowbox uses host
# networking, so its ports have to be opened in the host firewall. These
# rules don't survive a reboot, which is why this runs on every boot.
open_port() {
  iptables -w -C INPUT -p "$1" --dport "$2" -j ACCEPT 2>/dev/null ||
    iptables -w -A INPUT -p "$1" --dport "$2" -j ACCEPT
}
open_port tcp "${API_PORT}"
open_port tcp "${ACCESS_KEY_PORT}"
open_port udp "${ACCESS_KEY_PORT}"

wait_for_docker
log "pulling ${IMAGE}"
retry docker pull --quiet "${IMAGE}" >/dev/null
docker rm -f shadowbox >/dev/null 2>&1 || true

# --mount (unlike -v) refuses to start the container if the state directory
# is missing, so after a reboot Docker can't start shadowbox on an empty
# directory before the disk above is mounted.
docker run -d --name shadowbox --restart always --net host \
  --log-opt max-size=10m --log-opt max-file=3 \
  --mount "type=bind,source=${STATE_DIR},target=${STATE_DIR}" \
  -e "SB_STATE_DIR=${STATE_DIR}" \
  -e "SB_API_PORT=${API_PORT}" \
  -e SB_API_PREFIX \
  -e "SB_CERTIFICATE_FILE=${STATE_DIR}/shadowbox-selfsigned.crt" \
  -e "SB_PRIVATE_KEY_FILE=${STATE_DIR}/shadowbox-selfsigned.key" \
  "${IMAGE}" >/dev/null

log "Outline server started; management API on port ${API_PORT}, access keys on port ${ACCESS_KEY_PORT}"
