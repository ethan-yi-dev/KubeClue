import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentTool } from './agent.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHECKS = path.join(ROOT, 'checks')
const MAX_OUTPUT = 128 * 1024
const CHECK_TIMEOUT_MS = 90_000

type CheckResult = {
  check: string
  exit_code: number | null
  status: 'pass' | 'fail' | 'error'
  stdout: string
  stderr: string
}

async function runCommand(
  check: string,
  command: string,
  args: string[],
  input?: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      windowsHide: true,
      signal,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overflow = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, CHECK_TIMEOUT_MS)
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (stream === 'stdout') stdout += chunk.toString()
      else stderr += chunk.toString()
      if (stdout.length + stderr.length > MAX_OUTPUT) {
        overflow = true
        child.kill()
      }
    }
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve(JSON.stringify({ check, exit_code: null, status: 'error', stdout: '', stderr: error.message } satisfies CheckResult))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let status: CheckResult['status'] = timedOut || overflow || signal?.aborted
        ? 'error'
        : code === 0 ? 'pass' : code === 1 || (check === 'lab' && code !== null) ? 'fail' : 'error'
      if (status !== 'error' && (check === 'services' || check === 'connectivity')) {
        try {
          const report = JSON.parse(stdout)
          if (check === 'connectivity' && report?.summary?.actual_errors > 0) status = 'error'
        } catch {
          status = 'error'
          stderr += '\nCheck did not return a valid JSON report.'
        }
      }
      if (timedOut) stderr += '\nCheck timed out.'
      if (overflow) stderr += '\nCheck output exceeded limit.'
      if (signal?.aborted) stderr += '\nCheck aborted.'
      resolve(JSON.stringify({ check, exit_code: code, status, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT) } satisfies CheckResult))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

async function bashCommand(): Promise<string> {
  if (process.env.SRE_BASH) return process.env.SRE_BASH
  if (process.platform === 'win32') {
    // Git for Windows normally puts git.exe in .../cmd and bash.exe in .../bin.
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue
      const candidates = path.basename(dir).toLowerCase() === 'cmd'
        ? [path.resolve(dir, '..', 'bin', 'bash.exe')]
        : [path.join(dir, 'bash.exe')]
      for (const candidate of candidates) {
        // The Windows system32 bash.exe is a WSL launcher, not Git Bash.
        if (candidate.toLowerCase().includes(`${path.sep}system32${path.sep}`)) continue
        try { await fs.access(candidate); return candidate } catch { /* try next location */ }
      }
    }
  }
  return 'bash'
}

async function runBashCheck(check: string, filename: string, args: string[], signal?: AbortSignal): Promise<string> {
  const script = await fs.readFile(path.join(CHECKS, filename), 'utf8')
  // Feed the script through stdin so Windows and Unix paths work the same way.
  return runCommand(check, await bashCommand(), ['-s', '--', ...args], script, signal)
}

const baseline: AgentTool = {
  name: 'check_k8s_lab',
  description: 'Run checks/check-lab.sh: cluster, nodes, Cilium, lab Pods, Service endpoints, DNS, connectivity, and NetworkPolicy baseline. Returns status, exit code, and check output.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (_args, signal) => runBashCheck('lab', 'check-lab.sh', [], signal),
}

const health: AgentTool = {
  name: 'check_k8s_services',
  description: 'Run checks/health_check.sh for every Service in a namespace. Checks backing Pods, readiness, endpoints, and TCP access from netshoot. Returns a JSON report in stdout.',
  parameters: {
    type: 'object',
    properties: { namespace: { type: 'string', description: 'Kubernetes namespace, default sre-lab' } },
    additionalProperties: false,
  },
  execute: async (args, signal) => {
    const value = (args as { namespace?: unknown } | null)?.namespace ?? 'sre-lab'
    if (typeof value !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value) || value.length > 63) {
      return JSON.stringify({ check: 'services', exit_code: null, status: 'error', stdout: '', stderr: 'Invalid Kubernetes namespace.' } satisfies CheckResult)
    }
    return runBashCheck('services', 'health_check.sh', [value], signal)
  },
}

const connectivity: AgentTool = {
  name: 'check_k8s_connectivity',
  description: 'Run checks/conn_test.py with the checked-in connectivity specification. Tests HTTP, TCP, and DNS from netshoot and compares actual with expected results. Returns a JSON report in stdout.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (_args, signal) => runCommand(
    'connectivity',
    process.env.SRE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    [path.join(CHECKS, 'conn_test.py'), path.join(CHECKS, 'connectivity.json')],
    undefined,
    signal,
  ),
}

export function k8sTools(): AgentTool[] {
  return [baseline, health, connectivity]
}
