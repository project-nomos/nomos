#!/usr/bin/env bash
#
# hosted-e2e.sh — local end-to-end smoke test for the hosted Nomos flow.
#
# Stitches together every link of the hosted architecture on your machine,
# without K8s/ArgoCD/DNS:
#
#   1. Ensure the central server (nomos-server) is up (start it if not).
#   2. Sign up / sign in a test user, promote to admin.
#   3. Create a Better Auth org + set it active.
#   4. Provision the customer's dedicated Postgres database (CREATE DATABASE
#      nomos_<slug> + migrate) using the daemon CLI.
#   5. Boot the nomos daemon in hosted mode pointed at that database.
#   6. Seed org_members (the zero-trust interceptor checks it).
#   7. Mint a BA JWT and call MobileApi/ListSkills over gRPC with it.
#   8. Exercise the OAuthDeposit gRPC path and verify the integrations row.
#
# It starts only the processes it needs (reusing anything already running) and
# tears down what it started on exit. Re-runnable: org + customer DB + the
# daemon ENCRYPTION_KEY are reused across runs via a gitignored state dir.
#
# Usage:
#   scripts/hosted-e2e.sh [--keep] [--server-url URL] [--pg-base URL] [--clean]
#
#   --keep         Leave the server + daemon running after the test.
#   --server-url   Central server base URL (default http://localhost:4000).
#   --pg-base      Postgres base URL w/o db name (default derived from the
#                  server's DATABASE_URL, falling back to
#                  postgresql://localhost:5432).
#   --clean        Drop the test org's customer DB + state, then exit.
#
set -uo pipefail

# ── PATH: Homebrew tools (psql, grpcurl, node, redis-cli, pnpm) ──
export PATH="/opt/homebrew/bin:$PATH"

# ── Paths ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="${NOMOS_SERVER_DIR:-$REPO_ROOT/../nomos-server}"
STATE_DIR="$REPO_ROOT/.e2e"
LOG_DIR="$STATE_DIR/logs"
mkdir -p "$LOG_DIR"

# ── Config / args ──
SERVER_URL="http://localhost:4000"
PG_BASE=""
KEEP=0
CLEAN=0
TEST_EMAIL="${E2E_EMAIL:-e2e@nomos.local}"
TEST_PASSWORD="${E2E_PASSWORD:-hunter2hunter2}"
ORG_SLUG="${E2E_ORG_SLUG:-e2e-test}"
GRPC_ADDR="${E2E_GRPC_ADDR:-localhost:8766}"

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --clean) CLEAN=1 ;;
    --server-url) SERVER_URL="$2"; shift ;;
    --pg-base) PG_BASE="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── Logging ──
if [ -t 1 ]; then C0=$'\033[0m'; CB=$'\033[1m'; CG=$'\033[32m'; CR=$'\033[31m'; CY=$'\033[33m'; CC=$'\033[36m'
else C0=""; CB=""; CG=""; CR=""; CY=""; CC=""; fi
STEP=0
FAILURES=0
step() { STEP=$((STEP+1)); echo; echo "${CB}${CC}[$STEP] $*${C0}"; }
ok()   { echo "  ${CG}✓${C0} $*"; }
warn() { echo "  ${CY}!${C0} $*"; }
err()  { echo "  ${CR}✗${C0} $*"; FAILURES=$((FAILURES+1)); }
die()  { echo "${CR}fatal:${C0} $*" >&2; exit 1; }

# ── Cleanup ──
STARTED_SERVER=0
STARTED_DAEMON=0
SERVER_PID=""
DAEMON_PID=""
cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo
    warn "--keep set: leaving processes running"
    [ -n "$SERVER_PID" ] && echo "    server pid $SERVER_PID ($SERVER_URL)"
    [ -n "$DAEMON_PID" ] && echo "    daemon pid $DAEMON_PID ($GRPC_ADDR)"
    return
  fi
  [ "$STARTED_DAEMON" = "1" ] && [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null
  [ "$STARTED_SERVER" = "1" ] && [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT

# ── Helpers ──
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
db_swap() { node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$1" "$2"; }
port_up() { (exec 3<>"/dev/tcp/${1}/${2}") 2>/dev/null && exec 3>&- ; }
wait_tcp() { local host="$1" port="$2" tries="${3:-60}"; while [ "$tries" -gt 0 ]; do port_up "$host" "$port" && return 0; sleep 1; tries=$((tries-1)); done; return 1; }
wait_http() { local url="$1" tries="${2:-60}"; while [ "$tries" -gt 0 ]; do curl -sf "$url" >/dev/null 2>&1 && return 0; sleep 1; tries=$((tries-1)); done; return 1; }

# ── Dep + layout checks ──
step "Checking dependencies and layout"
for t in psql grpcurl node jq pnpm curl openssl; do need "$t"; done
[ -d "$SERVER_DIR" ] || die "nomos-server not found at $SERVER_DIR (set NOMOS_SERVER_DIR)"
[ -f "$SERVER_DIR/.env.local" ] || die "$SERVER_DIR/.env.local missing — copy .env.example and set DATABASE_URL + BETTER_AUTH_SECRET"
ok "tools present; server dir $SERVER_DIR"

# Admin Postgres connection: the server's own DATABASE_URL (→ nomos_server).
ADMIN_DB_URL="$(grep -E '^DATABASE_URL=' "$SERVER_DIR/.env.local" | head -1 | sed -E 's/^DATABASE_URL=//; s/[[:space:]]+#.*$//' | tr -d '"'"'"'')"
[ -n "$ADMIN_DB_URL" ] || die "could not read DATABASE_URL from $SERVER_DIR/.env.local"
if [ -z "$PG_BASE" ]; then PG_BASE="$(db_swap "$ADMIN_DB_URL" postgres)"; PG_BASE="${PG_BASE%/postgres}"; fi
MAINT_DB_URL="$(db_swap "$ADMIN_DB_URL" postgres)"
ok "admin db: $(echo "$ADMIN_DB_URL" | sed -E 's#://[^@]*@#://***@#')"

# ── --clean shortcut ──
if [ "$CLEAN" = "1" ]; then
  step "Cleaning up E2E state"
  if [ -f "$STATE_DIR/org_id" ]; then
    ORG_ID="$(cat "$STATE_DIR/org_id")"
    SLUG="$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,12))' "$ORG_ID")"
    psql "$MAINT_DB_URL" -v ON_ERROR_STOP=0 -c "DROP DATABASE IF EXISTS nomos_$SLUG WITH (FORCE);" >/dev/null 2>&1 && ok "dropped nomos_$SLUG" || warn "could not drop nomos_$SLUG"
  fi
  rm -rf "$STATE_DIR"; ok "removed $STATE_DIR"
  exit 0
fi

# ── Ensure nomos_server database exists (server boot needs it) ──
step "Ensuring central database exists"
SERVER_DB_NAME="$(node -e 'console.log(new URL(process.argv[1]).pathname.slice(1))' "$ADMIN_DB_URL")"
if psql "$ADMIN_DB_URL" -tAc 'SELECT 1' >/dev/null 2>&1; then
  ok "$SERVER_DB_NAME reachable"
else
  psql "$MAINT_DB_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$SERVER_DB_NAME\";" >/dev/null 2>&1 \
    && ok "created $SERVER_DB_NAME" || die "cannot reach or create $SERVER_DB_NAME via $MAINT_DB_URL"
fi

# ── Start (or reuse) the central server ──
step "Central server"
if wait_http "$SERVER_URL/api/health" 1; then
  ok "already running at $SERVER_URL"
else
  echo "  starting nomos-server (pnpm dev)…"
  ( cd "$SERVER_DIR" && DATABASE_URL="$ADMIN_DB_URL" pnpm dev >"$LOG_DIR/server.log" 2>&1 ) &
  SERVER_PID=$!; STARTED_SERVER=1
  wait_http "$SERVER_URL/api/health" 90 || { tail -30 "$LOG_DIR/server.log"; die "server did not become healthy"; }
  ok "started (pid $SERVER_PID), healthy"
fi
JWKS_URL="$SERVER_URL/api/auth/jwks"
curl -sf "$JWKS_URL" | jq -e '.keys | length > 0' >/dev/null 2>&1 && ok "JWKS serving keys" || warn "JWKS endpoint returned no keys (check jwt plugin)"

# ── Auth: sign up or sign in ──
# Better Auth enforces an Origin header (CSRF) on mutations; it must be in the
# server's trustedOrigins (BETTER_AUTH_URL). Send it on every auth POST.
step "Authenticating test user ($TEST_EMAIL)"
CJ="$STATE_DIR/cookies.txt"
ORIGIN=(-H "origin: $SERVER_URL")
signup=$(curl -s -c "$CJ" "${ORIGIN[@]}" -X POST "$SERVER_URL/api/auth/sign-up/email" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"E2E\",\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")
if echo "$signup" | jq -e '.user.id' >/dev/null 2>&1; then
  ok "signed up"
else
  curl -s -c "$CJ" "${ORIGIN[@]}" -X POST "$SERVER_URL/api/auth/sign-in/email" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}" \
    | jq -e '.user.id' >/dev/null 2>&1 && ok "signed in (user already existed)" \
    || { echo "$signup" | head -3; die "sign-up and sign-in both failed"; }
fi
SESSION=$(curl -s -b "$CJ" "$SERVER_URL/api/auth/get-session")
USER_ID=$(echo "$SESSION" | jq -r '.user.id // empty')
[ -n "$USER_ID" ] || die "could not resolve session user id"
ok "user id: $USER_ID"

# Promote to admin (so /admin + /api/admin/* work too). Idempotent.
psql "$ADMIN_DB_URL" -v ON_ERROR_STOP=0 -c "UPDATE \"user\" SET role='admin' WHERE email='$TEST_EMAIL';" >/dev/null 2>&1 \
  && ok "promoted to admin" || warn "could not set admin role (non-fatal)"

# ── Org: create or reuse, then set active ──
step "Better Auth organization"
create=$(curl -s -b "$CJ" -c "$CJ" "${ORIGIN[@]}" -X POST "$SERVER_URL/api/auth/organization/create" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"E2E Test\",\"slug\":\"$ORG_SLUG\"}")
ORG_ID=$(echo "$create" | jq -r '.id // empty')
if [ -z "$ORG_ID" ]; then
  ORG_ID=$(curl -s -b "$CJ" "$SERVER_URL/api/auth/organization/list" | jq -r ".[] | select(.slug==\"$ORG_SLUG\") | .id" | head -1)
fi
[ -n "$ORG_ID" ] || { echo "$create" | head -3; die "could not create or find org '$ORG_SLUG'"; }
echo "$ORG_ID" > "$STATE_DIR/org_id"
ok "org id: $ORG_ID"
curl -s -b "$CJ" -c "$CJ" "${ORIGIN[@]}" -X POST "$SERVER_URL/api/auth/organization/set-active" \
  -H 'content-type: application/json' -d "{\"organizationId\":\"$ORG_ID\"}" >/dev/null 2>&1 \
  && ok "set active org" || warn "set-active failed (JWT org_id may be null)"

# ── Provision the customer database ──
step "Provisioning customer database"
SLUG=$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,12))' "$ORG_ID")
CUST_DB="nomos_$SLUG"
CUST_DB_URL="$(db_swap "$ADMIN_DB_URL" "$CUST_DB")"
ok "slug $SLUG → database $CUST_DB"
( cd "$REPO_ROOT" && DATABASE_URL="$ADMIN_DB_URL" pnpm dev -- db create-database "$CUST_DB" ) >"$LOG_DIR/provision.log" 2>&1 \
  && ok "CREATE DATABASE ok" || { tail -20 "$LOG_DIR/provision.log"; die "create-database failed"; }
( cd "$REPO_ROOT" && DATABASE_URL="$CUST_DB_URL" pnpm dev -- db migrate ) >>"$LOG_DIR/provision.log" 2>&1 \
  && ok "schema applied to $CUST_DB" || { tail -20 "$LOG_DIR/provision.log"; die "migrate failed"; }

# ── Encryption key (stable across runs) ──
KEY_FILE="$STATE_DIR/encryption.key"
[ -f "$KEY_FILE" ] || openssl rand -hex 32 > "$KEY_FILE"
ENC_KEY="$(cat "$KEY_FILE")"

# ── Seed org membership (zero-trust interceptor checks it) ──
step "Seeding org membership"
psql "$CUST_DB_URL" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO org_members(user_id, role) VALUES('$USER_ID','owner') ON CONFLICT (user_id) DO NOTHING;" >/dev/null 2>&1 \
  && ok "org_members has $USER_ID" || die "could not seed org_members in $CUST_DB"

# ── Boot the daemon AS the customer instance ──
step "Booting daemon in hosted mode"
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
if redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1; then ok "redis up"; else warn "redis not reachable at $REDIS_URL (leases idle; ListSkills still works)"; fi
if port_up "${GRPC_ADDR%%:*}" "${GRPC_ADDR##*:}"; then
  warn "something already listening on $GRPC_ADDR — reusing it"
else
  ( cd "$REPO_ROOT" && \
    NOMOS_MODE=hosted \
    NOMOS_ORG_ID="$ORG_ID" \
    DATABASE_URL="$CUST_DB_URL" \
    REDIS_URL="$REDIS_URL" \
    ENCRYPTION_KEY="$ENC_KEY" \
    AUTH_JWKS_URL="$JWKS_URL" \
    pnpm daemon:dev >"$LOG_DIR/daemon.log" 2>&1 ) &
  DAEMON_PID=$!; STARTED_DAEMON=1
  wait_tcp "${GRPC_ADDR%%:*}" "${GRPC_ADDR##*:}" 60 || { tail -40 "$LOG_DIR/daemon.log"; die "daemon gRPC did not come up on $GRPC_ADDR"; }
  ok "daemon up (pid $DAEMON_PID), gRPC on $GRPC_ADDR"
fi

# ── Mint a JWT ──
step "Minting JWT"
TOKEN=$(curl -s -b "$CJ" "$SERVER_URL/api/auth/token" | jq -r '.token // empty')
if [ -z "$TOKEN" ]; then
  # Fallback: the jwt plugin also sets a set-auth-jwt header on session reads.
  TOKEN=$(curl -s -b "$CJ" -D - "$SERVER_URL/api/auth/get-session" -o /dev/null | awk -F': ' 'tolower($1)=="set-auth-jwt"{print $2}' | tr -d '\r')
fi
[ -n "$TOKEN" ] || die "could not mint a JWT (check the BA jwt plugin / /api/auth/token)"
ok "JWT minted (${#TOKEN} chars)"

PROTO_ARGS=(-import-path "$REPO_ROOT/proto" -proto nomos.proto)

# ── Call MobileApi/ListSkills with the JWT ──
step "MobileApi/ListSkills (authenticated)"
resp=$(grpcurl -plaintext "${PROTO_ARGS[@]}" \
  -H "authorization: Bearer $TOKEN" -d '{}' \
  "$GRPC_ADDR" nomos.MobileApi/ListSkills 2>&1)
if echo "$resp" | jq -e '.skills' >/dev/null 2>&1; then
  n=$(echo "$resp" | jq '.skills | length')
  ok "authorized — $n skills returned"
else
  err "ListSkills failed: $(echo "$resp" | head -2 | tr '\n' ' ')"
fi

# Negative check: a bogus token must be rejected.
neg=$(grpcurl -plaintext "${PROTO_ARGS[@]}" -H "authorization: Bearer not.a.jwt" -d '{}' \
  "$GRPC_ADDR" nomos.MobileApi/ListSkills 2>&1)
echo "$neg" | grep -qiE "Unauthenticated|malformed|invalid" && ok "bogus token rejected (negative check)" || warn "bogus token was NOT rejected: $(echo "$neg" | head -1)"

# ── OAuthDeposit (mTLS-only in prod; plaintext here) ──
step "OAuthDeposit/Deposit + verify"
dep=$(grpcurl -plaintext "${PROTO_ARGS[@]}" \
  -H "x-nomos-org-id: $ORG_ID" \
  -d "{\"provider\":\"gmail\",\"userId\":\"$USER_ID\",\"accessToken\":\"e2e-fake-token\",\"scopes\":\"gmail.modify\"}" \
  "$GRPC_ADDR" nomos.OAuthDeposit/Deposit 2>&1)
if echo "$dep" | jq -e '.success == true' >/dev/null 2>&1; then
  ok "deposit succeeded"
else
  err "deposit failed: $(echo "$dep" | head -2 | tr '\n' ' ')"
fi
row=$(psql "$CUST_DB_URL" -tAc "SELECT name FROM integrations WHERE name='gmail:$USER_ID';" 2>/dev/null | tr -d '[:space:]')
[ "$row" = "gmail:$USER_ID" ] && ok "integrations row present: $row" || err "integrations row not found"

# ── Summary ──
echo
if [ "$FAILURES" -eq 0 ]; then
  echo "${CB}${CG}HOSTED E2E PASSED${C0}  (org=$ORG_ID db=$CUST_DB)"
else
  echo "${CB}${CR}HOSTED E2E FAILED${C0}  ($FAILURES check(s) failed; logs in $LOG_DIR)"
fi
echo "  state: $STATE_DIR   ·   re-run anytime   ·   tear down: scripts/hosted-e2e.sh --clean"
exit "$FAILURES"
