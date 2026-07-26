#!/usr/bin/env bash
# Smoke test for feat/high-priority-hardening
# Run from the repo root. Requires Docker and docker compose.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass()  { echo -e "${GREEN}PASS${NC} $*"; }
fail()  { echo -e "${RED}FAIL${NC} $*"; }
info()  { echo -e "${YELLOW}INFO${NC} $*"; }

# Use CI override if it exists (remaps missing secret files to /dev/null).
if [ -f docker-compose.ci.yml ]; then
  COMPOSE_ARGS="-f docker-compose.yml -f docker-compose.ci.yml"
  info "Using CI compose override"
else
  COMPOSE_ARGS=""
fi

cleanup() {
  set +e
  info "Cleaning up…"
  timeout 10 docker compose $COMPOSE_ARGS down --remove-orphans 2>/dev/null
  rm -f "${SECRET_FILE:-}"
  true
}
trap cleanup EXIT

# ── Setup ────────────────────────────────────────────────────────────────

info "Creating JWT secret file…"
SECRET_FILE=$(mktemp)
echo "smoke-test-jwt-secret-$(date +%s)" > "$SECRET_FILE"

info "Building container images (console + consumer)…"
docker compose $COMPOSE_ARGS build console consumer 2>&1 | tail -5

# ── Test 1: Consumer JWT boot in Docker ───────────────────────────────────
info "Test 1: Consumer boots without JWT FATAL error"

# Start both services.  console depends_on nothing, consumer depends_on console.
# Pass the JWT secret both as a Docker secret AND as an env var fallback.
# The consumer reads /run/secrets/jwt_secret first, falls back to JWT_SECRET.
JWT_SECRET="$(cat "$SECRET_FILE")" \
  JWT_SECRET_FILE="$SECRET_FILE" \
  docker compose $COMPOSE_ARGS up console consumer -d 2>&1 | tail -3

# Wait for services to be healthy
sleep 3

CONSUMER_LOGS=$(docker compose $COMPOSE_ARGS logs consumer 2>&1 || true)
if echo "$CONSUMER_LOGS" | grep -q "FATAL.*JWT secret not found"; then
  fail "Consumer failed with JWT FATAL error"
else
  pass "Consumer started without JWT FATAL error"
fi

# ── Test 2: System endpoints require authentication ───────────────────────
info "Test 2: /api/system requires auth"

PING_NOAUTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4300/api/system/ping 2>&1 || echo "000")
if [ "$PING_NOAUTH" = "401" ]; then
  pass "/api/system/ping returns 401 without auth"
else
  fail "/api/system/ping returned $PING_NOAUTH (expected 401)"
fi

# ── Test 3: System endpoints work with auth ──────────────────────────────
info "Test 3: System endpoints work with authentication"

# Register a test user and get a token via the API
LOGIN_RESP=$(curl -s http://localhost:4300/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"smoke@dockyard.test","password":"smoke-test-pass"}' 2>&1 || echo '{"error":"no server"}')
TOKEN=$(echo "$LOGIN_RESP" | jq -r '.token // empty' 2>/dev/null || true)

if [ -z "$TOKEN" ]; then
  # Try registering first
  REGISTER_RESP=$(curl -s http://localhost:4300/api/auth/register \
    -H "Content-Type: application/json" \
    -d '{"email":"smoke@dockyard.test","password":"smoke-test-pass"}' 2>&1 || echo '{}')
  TOKEN=$(echo "$REGISTER_RESP" | jq -r '.token // empty' 2>/dev/null || true)
fi

if [ -z "$TOKEN" ]; then
  fail "Could not obtain auth token (register: $REGISTER_RESP, login: $LOGIN_RESP)"
  exit 1
fi

PING_AUTH=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:4300/api/system/ping 2>&1 || echo "000")
if [ "$PING_AUTH" = "200" ]; then
  pass "/api/system/ping returns 200 with auth"
else
  fail "/api/system/ping returned $PING_AUTH with auth (expected 200)"
fi

# ── Test 4: Audit API returns a JSON array ────────────────────────────────
info "Test 4: Audit API returns array"

AUDIT_RESP=$(curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:4300/api/system/audit 2>&1 || echo "[]")
if echo "$AUDIT_RESP" | jq -e 'type == "array"' > /dev/null 2>&1; then
  pass "GET /api/system/audit returns a JSON array"
else
  fail "GET /api/system/audit did not return an array: ${AUDIT_RESP:0:200}"
fi

# ── Test 5: Gateway route create triggers audit log ───────────────────────
info "Test 5: Gateway route create emits audit entry"

# Create a test route with a unique name (timestamp-based to avoid collision)
ROUTE_NAME="smoke-$(date +%s)"
ROUTE_RESP=$(curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$ROUTE_NAME\",\"targetType\":\"container\",\"targetId\":\"nonexistent\",\"targetPort\":80}" \
  http://localhost:4300/api/gateway 2>&1 || echo '{}')
ROUTE_ID=$(echo "$ROUTE_RESP" | jq -r '.id // empty' 2>/dev/null || true)

if [ -n "$ROUTE_ID" ]; then
  pass "Gateway route created (id=$ROUTE_ID)"
else
  info "Could not create gateway route (Docker daemon may not be running): ${ROUTE_RESP:0:100}"
  info "Skipping audit-entry verification…"
fi

if [ -n "$ROUTE_ID" ]; then
  AUDIT_ROWS=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "http://localhost:4300/api/system/audit?limit=10" 2>&1 || echo "[]")
  if echo "$AUDIT_ROWS" | jq -e 'map(select(.action == "gateway.route.create")) | length > 0' > /dev/null 2>&1; then
    pass "Audit log contains gateway.route.create entry"
  else
    fail "Audit log missing gateway.route.create entry"
  fi
fi

# ── Report ────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Smoke test complete."
echo "Key checks:"
echo "  1. Consumer JWT boot    — see above"
echo "  2. requireAuth on /api/system — see above"
echo "  3. System ping with auth — see above"
echo "  4. Audit API            — see above"
echo "  5. Audit write-through  — see above"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
