# Kubernetes SRE Toolkit

A lightweight collection of Bash utilities for validating Kubernetes networking, service connectivity, and common operational issues.

---

## Overview

This project provides small command-line tools for Kubernetes troubleshooting and SRE workflows.

Current components:

- ✅ **Health Check** – Validate Service health from both the Kubernetes control plane and the data plane.
- 🚧 **Connectivity Matrix** – Generate Pod-to-Pod and Service connectivity matrices.
- 🚧 **Incident Detector** – Detect common networking and configuration issues.

---

## Agent CLI

The TypeScript agent CLI requires Node.js 22.9 or newer and an OpenAI-compatible chat completions endpoint. Install dependencies and build it with:

```bash
npm ci
npm run build
```

Copy the example configuration to `.env`, then replace its placeholder values with settings from the same provider. In PowerShell:

```powershell
Copy-Item .env.example .env
# Edit .env to set MINIPI_API_KEY, MINIPI_MODEL, and MINIPI_BASE_URL.
npm start
```

`npm start` loads `.env` when it exists. Use `npm run dev` to build and start in one command. Conversation messages are saved in `~/.minipi/session.jsonl`.

---

## Features

### Health Check

The health check validates every Service in a namespace by performing:

- Discover Services
- Find backing Pods using the Service selector
- Verify all Pods are Ready
- Verify the Service has Endpoints
- Test TCP connectivity from a test Pod (`netshoot`)
- Generate a JSON health report

```bash
./scripts/health_check.sh <namespace>
```

Example:

```bash
./scripts/health_check.sh sre-lab
```

---

### Connectivity Matrix

Verify expected network connectivity against the live Kubernetes cluster.

Features:

- Read connectivity tests from a JSON specification
- Execute TCP (`nc`), HTTP (`curl`), and DNS (`nslookup`) checks from a source Pod
- Compare actual connectivity with expected results
- Generate structured JSON reports and return appropriate exit codes

Run the connectivity tests with:

```bash
python3 scripts/conn_test.py specs/connectivity.json
```

On Windows, you may need to use:

```bash
python scripts/conn_test.py specs/connectivity.json
```

The command exits with:

- `0` when all actual results match expectations
- `1` when one or more tests do not match expectations
- `2` when the specification or command arguments are invalid

---

### Incident Detector _(Coming Soon)_

Automatically detect common Kubernetes networking failures.

Planned checks:

- Missing Endpoints
- Pod Not Ready
- DNS failures
- Service port mismatch
- NetworkPolicy blocking
- ImagePullBackOff / CrashLoopBackOff

---

## Architecture

```
                        +----------------------+
                        |     Local Machine    |
                        |----------------------|
                        | kubectl / k9s        |
                        | health_check.sh      |
                        | conn_test.py         |
                        | incident_detector.py |
                        +----------+-----------+
                                   |
                                   | kubectl
                                   |
                    +--------------v---------------+
                    |        kind Kubernetes       |
                    |           Cluster            |
                    +--------------+---------------+
                                   |
                          Namespace: sre-lab
                                   |
        +--------------------------+--------------------------+
        |                          |                          |
        |                          |                          |
+-------v--------+        +--------v--------+        +--------v--------+
|    netshoot    |        |     Service     |        |     Service     |
| (test client)  |------->|      nginx      |------->|      redis      |
+----------------+        +--------+--------+        +--------+--------+
                                    |                          |
                              +-----+-----+                    |
                              |           |                    |
                       +------v----+ +----v------+       +-----v------+
                       | nginx Pod | | nginx Pod |       | redis Pod  |
                       +-----------+ +-----------+       +------------+

                CoreDNS provides in-cluster DNS resolution
```

---

## Prerequisites

- Docker
- kind
- kubectl
- k9s (optional)

Verify the cluster is reachable.

```bash
kubectl get nodes
```

## Setup

Make the scripts executable.

```bash
chmod +x scripts/*.sh
```

Create the demo topology.

```bash
./scripts/setup.sh
```

Validate the environment.

```bash
./scripts/check.sh
```

---

## Usage

### Health Check

Run against a namespace:

```bash
./scripts/health_check.sh <namespace>
```

Example:

```bash
./scripts/health_check.sh sre-lab
```

---

### Connectivity Matrix _(Coming Soon)_

```bash
./scripts/connectivity_matrix.sh <namespace>
```

---

### Incident Detector _(Coming Soon)_

```bash
./scripts/incident_detector.sh <namespace>
```

---

## Example Output

```json
[
  {
    "service": "nginx",
    "namespace": "sre-lab",
    "healthy": true,
    "endpoints": 2,
    "reason": "ok"
  },
  {
    "service": "redis",
    "namespace": "sre-lab",
    "healthy": true,
    "endpoints": 1,
    "reason": "ok"
  }
]
```

Exit codes:

| Code | Meaning                          |
| ---- | -------------------------------- |
| 0    | All Services are healthy         |
| 1    | One or more health checks failed |
| 2    | Invalid arguments or environment |

---

## Troubleshooting

| Reason               | Description                                                                       |
| -------------------- | --------------------------------------------------------------------------------- |
| `no backing pods`    | The Service selector does not match any Pods.                                     |
| `not ready`          | One or more backend Pods are not Ready.                                           |
| `no endpoints`       | The Service has no Ready Endpoints.                                               |
| `connection refused` | The Service is reachable but the application is not listening on the target port. |
| `timeout`            | DNS, NetworkPolicy, or routing prevented the TCP connection.                      |

---

## Roadmap

- [x] Health Check
- [x] Connectivity Matrix
- [ ] Incident Detector
- [ ] JSON Schema documentation
- [ ] GitHub Actions integration
