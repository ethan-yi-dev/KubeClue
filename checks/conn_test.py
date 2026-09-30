#!/usr/bin/env python3

"""
Connectivity Matrix Tester

Usage:
    python3 checks/conn_test.py <spec.json>

Example:
    python3 checks/conn_test.py checks/connectivity.json

Supported test types:
    tcp   - Uses nc
    http  - Uses curl
    dns   - Uses nslookup

Exit codes:
    0 - All tests matched expectations
    1 - One or more tests failed or did not match expectations
    2 - Invalid arguments or invalid spec file
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_TIMEOUT_SECONDS = 5
VALID_TEST_TYPES = {"tcp", "http", "dns"}
VALID_EXPECTATIONS = {"pass", "fail"}


def run_command(command: list[str], timeout: int) -> dict[str, Any]:
    """
    Run a command and return a normalized result.

    A timeout or missing executable is treated as a failed command.
    """
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )

        return {
            "success": completed.returncode == 0,
            "exit_code": completed.returncode,
            "stdout": completed.stdout.strip(),
            "stderr": completed.stderr.strip(),
        }

    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout.decode() if isinstance(exc.stdout, bytes) else exc.stdout
        stderr = exc.stderr.decode() if isinstance(exc.stderr, bytes) else exc.stderr

        return {
            "success": False,
            "exit_code": None,
            "stdout": (stdout or "").strip(),
            "stderr": (stderr or "").strip(),
            "error": f"command timed out after {timeout} seconds",
        }

    except FileNotFoundError:
        return {
            "success": False,
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "error": f"executable not found: {command[0]}",
        }

    except OSError as exc:
        return {
            "success": False,
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "error": f"could not execute {command[0]}: {exc}",
        }


def load_spec(spec_path: Path) -> dict[str, Any]:
    """Load and validate the top-level JSON specification."""
    if not spec_path.exists():
        raise ValueError(f"spec file does not exist: {spec_path}")

    try:
        with spec_path.open("r", encoding="utf-8") as file:
            spec = json.load(file)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}"
        ) from exc

    if not isinstance(spec, dict):
        raise ValueError("spec must be a JSON object")

    tests = spec.get("tests")

    if not isinstance(tests, list):
        raise ValueError('spec must contain a "tests" array')

    if not tests:
        raise ValueError('"tests" array cannot be empty')

    return spec


def validate_test(test: Any, index: int) -> dict[str, Any]:
    """Validate and normalize one connectivity test."""
    if not isinstance(test, dict):
        raise ValueError(f"test #{index} must be a JSON object")

    required_fields = {
        "from_pod",
        "from_namespace",
        "to_host",
        "test_type",
        "expect",
    }

    missing_fields = sorted(required_fields - test.keys())

    if missing_fields:
        raise ValueError(
            f"test #{index} is missing fields: {', '.join(missing_fields)}"
        )

    test_type = str(test["test_type"]).lower()
    expectation = str(test["expect"]).lower()

    if test_type not in VALID_TEST_TYPES:
        raise ValueError(
            f'test #{index} has unsupported test_type "{test_type}"'
        )

    if expectation not in VALID_EXPECTATIONS:
        raise ValueError(
            f'test #{index} expect must be "pass" or "fail"'
        )

    if test_type in {"tcp", "http"} and "to_port" not in test:
        raise ValueError(
            f'test #{index} requires "to_port" for test_type "{test_type}"'
        )

    normalized = dict(test)
    normalized["test_type"] = test_type
    normalized["expect"] = expectation
    normalized["timeout_seconds"] = int(
        test.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
    )

    if normalized["timeout_seconds"] <= 0:
        raise ValueError(f"test #{index} timeout_seconds must be greater than 0")

    if "to_port" in normalized:
        normalized["to_port"] = int(normalized["to_port"])

        if not 1 <= normalized["to_port"] <= 65535:
            raise ValueError(f"test #{index} has an invalid port")

    return normalized


def find_source_pod(
    namespace: str,
    requested_name: str,
    timeout: int,
) -> dict[str, Any]:
    """
    Find the source Pod.

    Resolution order:
    1. Exact Pod name
    2. Pod label app=<from_pod>
    3. Running Pod whose name begins with <from_pod>-

    This allows both:
        "from_pod": "netshoot"

    and Deployment-generated Pod names such as:
        netshoot-7c956d59f9-xp2zb
    """

    exact_lookup = run_command(
        [
            "kubectl",
            "get",
            "pod",
            requested_name,
            "-n",
            namespace,
            "-o",
            "json",
        ],
        timeout,
    )

    if exact_lookup["success"]:
        pod = json.loads(exact_lookup["stdout"])

        return validate_pod_status(pod, requested_name)

    label_lookup = run_command(
        [
            "kubectl",
            "get",
            "pods",
            "-n",
            namespace,
            "-l",
            f"app={requested_name}",
            "-o",
            "json",
        ],
        timeout,
    )

    if label_lookup["success"]:
        pod_list = json.loads(label_lookup["stdout"])

        for pod in pod_list.get("items", []):
            if pod.get("status", {}).get("phase") == "Running":
                return validate_pod_status(pod, requested_name)

    all_pods_lookup = run_command(
        [
            "kubectl",
            "get",
            "pods",
            "-n",
            namespace,
            "-o",
            "json",
        ],
        timeout,
    )

    if all_pods_lookup["success"]:
        pod_list = json.loads(all_pods_lookup["stdout"])
        name_prefix = f"{requested_name}-"

        for pod in pod_list.get("items", []):
            pod_name = pod.get("metadata", {}).get("name", "")
            pod_phase = pod.get("status", {}).get("phase")

            if pod_name.startswith(name_prefix) and pod_phase == "Running":
                return validate_pod_status(pod, requested_name)

    lookup_errors = [
        result.get("error")
        for result in (exact_lookup, label_lookup, all_pods_lookup)
    ]
    if all(lookup_errors):
        reason = f"kubectl unavailable: {lookup_errors[0]}"
    else:
        reason = (
            f'source pod "{requested_name}" was not found or is not running '
            f'in namespace "{namespace}"'
        )

    result = {
        "found": False,
        "pod_name": None,
        "reason": reason,
    }
    if all(lookup_errors):
        result["error"] = reason
    return result


def validate_pod_status(
    pod: dict[str, Any],
    requested_name: str,
) -> dict[str, Any]:
    """Check whether a resolved Pod is running."""
    pod_name = pod.get("metadata", {}).get("name", requested_name)
    phase = pod.get("status", {}).get("phase", "Unknown")

    if phase != "Running":
        return {
            "found": False,
            "pod_name": pod_name,
            "reason": f'source pod "{pod_name}" is in phase "{phase}"',
        }

    return {
        "found": True,
        "pod_name": pod_name,
        "reason": "ok",
    }


def build_test_command(
    test: dict[str, Any],
    pod_name: str,
) -> list[str]:
    """Build the kubectl exec command for a test."""
    namespace = test["from_namespace"]
    host = str(test["to_host"])
    test_type = test["test_type"]
    timeout = test["timeout_seconds"]

    base_command = [
        "kubectl",
        "exec",
        "-n",
        namespace,
        pod_name,
        "--",
    ]

    if test_type == "tcp":
        port = str(test["to_port"])

        return base_command + [
            "nc",
            "-z",
            "-w",
            str(timeout),
            host,
            port,
        ]

    if test_type == "http":
        port = test["to_port"]
        path = str(test.get("path", "/"))

        if not path.startswith("/"):
            path = f"/{path}"

        scheme = str(test.get("scheme", "http"))
        url = f"{scheme}://{host}:{port}{path}"

        return base_command + [
            "curl",
            "-fsS",
            "--connect-timeout",
            str(timeout),
            "--max-time",
            str(timeout),
            url,
        ]

    if test_type == "dns":
        return base_command + [
            "nslookup",
            host,
        ]

    raise ValueError(f"unsupported test type: {test_type}")


def execute_test(test: dict[str, Any], index: int) -> dict[str, Any]:
    """Resolve the source Pod, run the test, and compare actual vs expected."""
    source = find_source_pod(
        namespace=str(test["from_namespace"]),
        requested_name=str(test["from_pod"]),
        timeout=test["timeout_seconds"],
    )

    base_result: dict[str, Any] = {
        "id": test.get("name", f"test-{index}"),
        "from_pod": test["from_pod"],
        "resolved_from_pod": source.get("pod_name"),
        "from_namespace": test["from_namespace"],
        "to_host": test["to_host"],
        "test_type": test["test_type"],
        "expected": test["expect"],
    }

    if "to_port" in test:
        base_result["to_port"] = test["to_port"]

    if not source["found"]:
        actual = "error" if source.get("error") else "fail"
        matched = actual == test["expect"]

        return {
            **base_result,
            "actual": actual,
            "matched": matched,
            "exit_code": None,
            "reason": source["reason"],
        }

    command = build_test_command(test, source["pod_name"])

    command_result = run_command(
        command,
        timeout=test["timeout_seconds"] + 3,
    )

    actual = (
        "error" if command_result.get("error")
        else "pass" if command_result["success"]
        else "fail"
    )
    matched = actual == test["expect"]

    result = {
        **base_result,
        "actual": actual,
        "matched": matched,
        "exit_code": command_result["exit_code"],
        "reason": "expectation matched" if matched else "expectation mismatch",
    }

    if command_result.get("stdout"):
        result["stdout"] = command_result["stdout"]

    if command_result.get("stderr"):
        result["stderr"] = command_result["stderr"]

    if command_result.get("error"):
        result["error"] = command_result["error"]

    return result


def build_report(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Create the final structured report."""
    matched_count = sum(1 for result in results if result["matched"])
    mismatched_count = len(results) - matched_count
    actual_passed = sum(1 for result in results if result["actual"] == "pass")
    actual_failed = sum(1 for result in results if result["actual"] == "fail")
    actual_errors = sum(1 for result in results if result["actual"] == "error")

    return {
        "tests": results,
        "summary": {
            "total": len(results),
            "matched": matched_count,
            "mismatched": mismatched_count,
            "actual_passed": actual_passed,
            "actual_failed": actual_failed,
            "actual_errors": actual_errors,
            "healthy": mismatched_count == 0,
        },
    }


def main() -> int:
    if len(sys.argv) != 2:
        print(
            json.dumps(
                {
                    "error": "usage: conn_test.py <spec.json>",
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2

    spec_path = Path(sys.argv[1])

    try:
        spec = load_spec(spec_path)

        validated_tests = [
            validate_test(test, index)
            for index, test in enumerate(spec["tests"], start=1)
        ]

    except (ValueError, TypeError) as exc:
        print(
            json.dumps(
                {
                    "error": str(exc),
                },
                indent=2,
            ),
            file=sys.stderr,
        )
        return 2

    results = [
        execute_test(test, index)
        for index, test in enumerate(validated_tests, start=1)
    ]

    report = build_report(results)

    print(json.dumps(report, indent=2))

    return 0 if report["summary"]["healthy"] else 1


if __name__ == "__main__":
    sys.exit(main())
