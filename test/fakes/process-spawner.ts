import { spawn, type ChildProcess } from 'node:child_process'
import type { AgentSpawner } from '../../src/main/agents'
import type { SpawnPlan } from '../../src/main/engines'

/**
 * `AgentSpawner` over real child processes.
 *
 * `PtyManager` is the production implementation and cannot load under the Node
 * test runner (it imports node-pty, which `electron-rebuild` links against
 * Electron's ABI — BUILD-PROMPT §10.3). This is the same seam with
 * `child_process` behind it, which is enough for the one thing S-CRASH needs
 * and cannot fake: a **real process that can really be SIGKILLed**. A stubbed
 * spawner would let the scenario pass with the whole crash path deleted.
 */
export class ProcessSpawner implements AgentSpawner {
  private readonly children = new Map<string, ChildProcess>()
  private readonly exitHandlers: ((id: string, exitCode: number) => void)[] = []
  private readonly output = new Map<string, string>()

  spawnAgent(id: string, plan: SpawnPlan): void {
    const [command, ...args] = plan.argv
    if (command === undefined) throw new Error(`process-spawner: empty argv for "${id}"`)
    const child = spawn(command, args, {
      cwd: plan.cwd,
      env: { ...plan.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.children.set(id, child)
    this.output.set(id, '')
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      this.output.set(id, (this.output.get(id) ?? '') + chunk)
    })
    child.stderr?.resume()
    child.on('error', () => this.children.delete(id))
    child.on('exit', (code, signal) => {
      this.children.delete(id)
      // A SIGKILLed process reports a null code; the harness's contract is a
      // number, and -1 says "died on a signal" rather than "exited cleanly".
      const exitCode = code ?? -1
      void signal
      for (const handler of this.exitHandlers) handler(id, exitCode)
    })
  }

  write(id: string, data: string): void {
    this.children.get(id)?.stdin?.write(data)
  }

  /** SIGKILL: the crash S-CRASH is about, not a polite shutdown. */
  kill(id: string): void {
    this.children.get(id)?.kill('SIGKILL')
  }

  has(id: string): boolean {
    return this.children.has(id)
  }

  onExit(cb: (id: string, exitCode: number) => void): void {
    this.exitHandlers.push(cb)
  }

  /** Everything this spawn has printed so far — how the agent reports back. */
  stdoutOf(id: string): string {
    return this.output.get(id) ?? ''
  }

  /** Kills anything still alive; teardown must not leak processes into CI. */
  killAll(): void {
    for (const id of [...this.children.keys()]) this.kill(id)
  }
}
