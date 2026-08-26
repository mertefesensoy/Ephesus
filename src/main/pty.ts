import os from 'node:os'
import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import { ptyDataChannel, ptyExitChannel } from '../shared/ipc'

/**
 * PtyManager (SDD §1.1, ADR-0014): owns every agent/shell PTY.
 * Contract: spawn/write/resize/kill by id; all output bytes are forwarded to the
 * attached sink over the per-id channel `pty:data:<id>` — no buffering, no JSON
 * wrapping of the byte stream (SDD §11). The redaction filter (ADR-0010) attaches
 * here when the secret broker lands in M3.
 */
export class PtyManager {
  private readonly ptys = new Map<string, pty.IPty>()
  private sink: WebContents | null = null

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
    this.ptys.set(id, proc)
    proc.onData((data) => {
      this.sink?.send(ptyDataChannel(id), data)
    })
    proc.onExit(({ exitCode }) => {
      this.ptys.delete(id)
      this.sink?.send(ptyExitChannel(id), exitCode)
    })
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
