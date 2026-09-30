#!/usr/bin/env bash

set -uo pipefail

NAMESPACE="${1:-}"
TEST_POD="${HEALTH_CHECK_POD:-netshoot}"
TIMEOUT_SECONDS="${HEALTH_CHECK_TIMEOUT:-3}"

if [[ -z "$NAMESPACE" ]]; then
    echo "Usage: $0 <namespace>" >&2
    exit 2
fi

if ! command -v kubectl >/dev/null 2>&1; then
    echo "Error: kubectl is required." >&2
    exit 2
fi

if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
    echo "Error: cannot read namespace '$NAMESPACE'; check its existence, kubectl context, and cluster access." >&2
    exit 2
fi

if ! kubectl get pod "$TEST_POD" -n "$NAMESPACE" >/dev/null 2>&1; then
    echo "Error: cannot read test pod '$TEST_POD' in namespace '$NAMESPACE'; check its existence and access." >&2
    exit 2
fi

OVERALL_HEALTHY=true
FIRST=true

# ============================================================
# STEP 1: Get every Service in the namespace
# ============================================================

SERVICES=$(kubectl get services -n "$NAMESPACE" \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')

echo "["

for SERVICE in $SERVICES; do
    HEALTHY=true
    REASON="ok"

    # ========================================================
    # STEP 2: Check backing Pods and their Ready status
    # ========================================================

    SELECTOR=$(kubectl get service "$SERVICE" -n "$NAMESPACE" \
        -o go-template='{{range $key, $value := .spec.selector}}{{$key}}={{$value}},{{end}}')

    SELECTOR="${SELECTOR%,}"

    POD_COUNT=0
    READY_COUNT=0

    if [[ -n "$SELECTOR" ]]; then
        POD_COUNT=$(kubectl get pods -n "$NAMESPACE" \
            -l "$SELECTOR" \
            --no-headers 2>/dev/null |
            grep -c . || true)

        READY_COUNT=$(kubectl get pods -n "$NAMESPACE" \
            -l "$SELECTOR" \
            --no-headers 2>/dev/null |
            awk '{
                split($2, ready, "/")
                if (ready[1] == ready[2]) {
                    count++
                }
            }
            END {
                print count+0
            }')

        if [[ "$POD_COUNT" -eq 0 ]]; then
            HEALTHY=false
            REASON="no endpoints"
        elif [[ "$READY_COUNT" -lt "$POD_COUNT" ]]; then
            HEALTHY=false
            REASON="not ready"
        fi
    fi

    # ========================================================
    # STEP 3: Check whether the Service has endpoints
    # ========================================================

    ENDPOINT_COUNT=$(kubectl get endpoints "$SERVICE" -n "$NAMESPACE" \
        -o jsonpath='{range .subsets[*].addresses[*]}{.ip}{"\n"}{end}' \
        2>/dev/null |
        grep -c . || true)

    if [[ "$HEALTHY" == "true" && "$ENDPOINT_COUNT" -eq 0 ]]; then
        HEALTHY=false
        REASON="no endpoints"
    fi

    # ========================================================
    # STEP 4: Test a real TCP connection from netshoot
    # ========================================================

    if [[ "$HEALTHY" == "true" ]]; then
        SERVICE_PORT=$(kubectl get service "$SERVICE" -n "$NAMESPACE" \
            -o jsonpath='{.spec.ports[0].port}')

        if CONNECTION_OUTPUT=$(MSYS_NO_PATHCONV=1 kubectl exec \
            -n "$NAMESPACE" \
            "$TEST_POD" \
            -- nc -zv -w "$TIMEOUT_SECONDS" \
            "$SERVICE" "$SERVICE_PORT" 2>&1); then

            REASON="ok"
        else
            HEALTHY=false

            if echo "$CONNECTION_OUTPUT" | grep -qi "refused"; then
                REASON="connection refused"
            else
                REASON="timeout"
            fi
        fi
    fi

    if [[ "$HEALTHY" == "false" ]]; then
        OVERALL_HEALTHY=false
    fi

    if [[ "$FIRST" == "false" ]]; then
        echo ","
    fi

    printf '  {"service":"%s","namespace":"%s","healthy":%s,"endpoints":%s,"reason":"%s"}' \
        "$SERVICE" \
        "$NAMESPACE" \
        "$HEALTHY" \
        "$ENDPOINT_COUNT" \
        "$REASON"

    FIRST=false
done

echo
echo "]"

if [[ "$OVERALL_HEALTHY" == "true" ]]; then
    exit 0
else
    exit 1
fi
