import os from 'node:os'
import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import { ptyDataChannel, ptyExitChannel } from '../shared/ipc'
import type { AgentSpawner } from './agents'
import type { SpawnPlan } from './engines'
import { resolveExecutable } from './which'

/**
 * PtyManager (SDD §1.1, ADR-0014): owns every agent/shell PTY.
 * Contract: spawn/write/resize/kill by id; all output bytes are forwarded to the
 * attached sink over the per-id channel `pty:data:<id>` — no buffering, no JSON
 * wrapping of the byte stream (SDD §11). The redaction filter (ADR-0010) attaches
 * here when the secret broker lands in M3.
 */
export class PtyManager implements AgentSpawner {
  private readonly ptys = new Map<string, pty.IPty>()
  private sink: WebContents | null = null
  private readonly exitListeners: ((id: string, exitCode: number) => void)[] = []

  /** Later PTY output flows to this renderer; call on window (re)creation. */
  attachSink(sink: WebContents): void {
    this.sink = sink
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  /** Spawns the platform's default interactive shell under the given id (M0.3: hardcoded). */
  spawnShell(id: string): void {
    if (this.ptys.has(id)) return
    const shell =
      process.platform === 'win32' ? 'powershell.exe' : (process.env['SHELL'] ?? '/bin/bash')
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: process.env as Record<string, string>
    })
    this.track(id, proc)
  }

  private track(id: string, proc: pty.IPty): void {
    this.ptys.set(id, proc)
    proc.onData((data) => {
      this.sink?.send(ptyDataChannel(id), data)
    })
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(id)
      this.sink?.send(ptyExitChannel(id), exitCode)
      for (const listener of this.exitListeners) listener(id, exitCode)
    })
  }

  /**
   * Starts an agent under a spawn plan (ADR-0009). The plan's `env` is the
   * WHOLE environment the child gets — `process.env` is deliberately not spread
   * in here, because the adapter already composed base ∪ grants ∪ harness vars
   * under the ADR-0010 allowlist, and re-adding the harness's own environment
   * would quietly undo that.
   *
   * `argv[0]` is resolved against the plan's own PATH before spawning: a PTY
   * spawn on Windows does not walk PATH/PATHEXT, so a bare `claude` — an npm
   * `.cmd`/`.exe` shim — fails with ERROR_FILE_NOT_FOUND (see which.ts).
   */
  spawnAgent(id: string, plan: SpawnPlan): void {
    if (this.ptys.has(id)) return
    const [command, ...args] = plan.argv
    if (command === undefined) throw new Error(`pty: empty argv in spawn plan for "${id}"`)
    // Resolved against the agent's OWN PATH (the plan's env), not the harness's:
    // a conpty spawn does not walk PATH/PATHEXT for us.
    const executable = resolveExecutable(command, plan.env)
    const proc = pty.spawn(executable, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: plan.cwd,
      env: { ...plan.env },
      useConpty: process.platform === 'win32'
    })
    this.track(id, proc)
  }

  /** Subscribes to pty exits; `AgentManager` unwinds spawns from here. */
  onExit(cb: (id: string, exitCode: number) => void): void {
    this.exitListeners.push(cb)
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.ptys.get(id)?.resize(cols, rows)
  }

  kill(id: string): void {
    this.ptys.get(id)?.kill()
  }

  killAll(): void {
    for (const [, proc] of this.ptys) proc.kill()
    this.ptys.clear()
  }
}
