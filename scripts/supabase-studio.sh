#
# Supabase Studio VM (managed instance group). Runs three containers on a
# private Docker network:
#
#   studio-proxy  nginx with basic auth, the only published port
#   studio        Supabase Studio (port 3000, not published)
#   pg-meta       postgres-meta (port 8080, not published)
#
# postgres-meta has no authentication of its own, and Studio's API runs SQL as
# the database user, so neither may be reachable except through the proxy.

readonly APP_DIR=/var/lib/supabase-studio
readonly DOCKER_NETWORK=supabase

STUDIO_IMAGE="$(attr studio-image)"
PG_META_IMAGE="$(attr pg-meta-image)"
PROXY_IMAGE="$(attr proxy-image)"
PROXY_PORT="$(attr proxy-port)"
DB_HOST="$(attr db-host)"
DB_PORT="$(attr db-port)"
DB_NAME="$(attr db-name)"
DB_USER="$(attr db-user)"
ORGANIZATION_NAME="$(attr studio-organization-name)"
PROJECT_NAME="$(attr studio-project-name)"

log "reading secrets from Secret Manager"
DB_PASSWORD="$(read_secret "$(attr db-password-secret)")"
PG_META_CRYPTO_KEY="$(read_secret "$(attr pg-meta-crypto-key-secret)")"
HTPASSWD="$(read_secret "$(attr studio-htpasswd-secret)")"

umask 077
mkdir -p "${APP_DIR}/snippets"

# Docker reads env files when a container is created; the values are not on
# any command line.
cat >"${APP_DIR}/pg-meta.env" <<EOF
PG_META_PORT=8080
PG_META_DB_HOST=${DB_HOST}
PG_META_DB_PORT=${DB_PORT}
PG_META_DB_NAME=${DB_NAME}
PG_META_DB_USER=${DB_USER}
PG_META_DB_PASSWORD=${DB_PASSWORD}
CRYPTO_KEY=${PG_META_CRYPTO_KEY}
EOF

# Studio sends its own connection string (built from POSTGRES_* and
# POSTGRES_USER_READ_WRITE) to postgres-meta, encrypted with the shared
# crypto key. Snippets are saved on this VM's disk.
cat >"${APP_DIR}/studio.env" <<EOF
HOSTNAME=0.0.0.0
STUDIO_PG_META_URL=http://pg-meta:8080
POSTGRES_HOST=${DB_HOST}
POSTGRES_PORT=${DB_PORT}
POSTGRES_DB=${DB_NAME}
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_USER_READ_WRITE=${DB_USER}
PG_META_CRYPTO_KEY=${PG_META_CRYPTO_KEY}
DEFAULT_ORGANIZATION_NAME=${ORGANIZATION_NAME}
DEFAULT_PROJECT_NAME=${PROJECT_NAME}
SNIPPETS_MANAGEMENT_FOLDER=/app/snippets
ENABLED_FEATURES_LOGS_ALL=false
NEXT_TELEMETRY_DISABLED=1
EOF

printf '%s\n' "${HTPASSWD}" >"${APP_DIR}/htpasswd"
# 101 is the nginx user in the official image; its workers read this file.
chown 101:101 "${APP_DIR}/htpasswd"
chmod 0400 "${APP_DIR}/htpasswd"

cat >"${APP_DIR}/nginx.conf" <<'EOF'
# Basic auth in front of Supabase Studio. Written by the VM's startup script.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 8000;
    server_tokens off;
    client_max_body_size 50m;

    # Docker's DNS, re-resolved so a recreated studio container is found.
    resolver 127.0.0.11 valid=10s ipv6=off;
    set $studio http://studio:3000;

    # Health check for the load balancer and for auto-healing: this exact
    # path only, without credentials. Studio answers it with static JSON.
    location = /healthz {
        access_log off;
        proxy_pass $studio/api/platform/profile;
    }

    location / {
        auth_basic "Supabase Studio";
        auth_basic_user_file /etc/nginx/htpasswd;

        proxy_pass $studio;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        # Studio doesn't need the basic-auth credentials.
        proxy_set_header Authorization "";
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
EOF
chmod 0444 "${APP_DIR}/nginx.conf"

wait_for_docker
docker network inspect "${DOCKER_NETWORK}" >/dev/null 2>&1 ||
  docker network create "${DOCKER_NETWORK}" >/dev/null

for image in "${PG_META_IMAGE}" "${STUDIO_IMAGE}" "${PROXY_IMAGE}"; do
  log "pulling ${image}"
  retry docker pull --quiet "${image}" >/dev/null
done

# Recreate the containers on every boot so they pick up changed settings.
docker rm -f studio-proxy studio pg-meta >/dev/null 2>&1 || true

LOG_OPTS=(--log-opt max-size=10m --log-opt max-file=3)

docker run -d --name pg-meta --network "${DOCKER_NETWORK}" --restart always \
  "${LOG_OPTS[@]}" \
  --env-file "${APP_DIR}/pg-meta.env" \
  "${PG_META_IMAGE}" >/dev/null

docker run -d --name studio --network "${DOCKER_NETWORK}" --restart always \
  "${LOG_OPTS[@]}" \
  --env-file "${APP_DIR}/studio.env" \
  --mount "type=bind,source=${APP_DIR}/snippets,target=/app/snippets" \
  "${STUDIO_IMAGE}" >/dev/null

docker run -d --name studio-proxy --network "${DOCKER_NETWORK}" --restart always \
  "${LOG_OPTS[@]}" \
  -p "${PROXY_PORT}:8000" \
  --mount "type=bind,source=${APP_DIR}/nginx.conf,target=/etc/nginx/conf.d/default.conf,readonly" \
  --mount "type=bind,source=${APP_DIR}/htpasswd,target=/etc/nginx/htpasswd,readonly" \
  "${PROXY_IMAGE}" >/dev/null

log "containers started; the instance turns healthy once :${PROXY_PORT}/healthz answers"
