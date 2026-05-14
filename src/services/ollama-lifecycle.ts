import { spawn as nodeSpawn } from "node:child_process";

export type OllamaStatus =
  | "detecting"       // initial state on plugin load
  | "starting"        // spawn in progress, waiting for /api/tags
  | "ready"           // /api/tags responding
  | "not_responding"  // 3+ consecutive health-check failures
  | "restarting"      // restart attempt in progress
  | "not_installed";  // Ollama binary not found

export interface ChildProcessHandle {
  pid?: number;
  kill(signal?: string): void;
  stdout: { on(event: "data", cb: (data: Buffer | string) => void): void } | null;
  stderr: { on(event: "data", cb: (data: Buffer | string) => void): void } | null;
  once(event: "exit", cb: (code: number | null) => void): void;
}

export interface OllamaLifecycleDeps {
  /** Ollama API base. Default: http://127.0.0.1:11434 */
  baseUrl?: string;
  /** Path to the Ollama binary. Default: "ollama" (PATH lookup). */
  ollamaCmd?: string;
  /** Line-level logger; defaults to console.log. */
  log?: (line: string) => void;
  /** Fired on every status transition. */
  onStatusChange?: (status: OllamaStatus) => void;
  /** Injectable so tests never actually spawn processes. */
  spawnFn?: (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcessHandle;
  /** Injectable health probe. Returns true when /api/tags responds OK. */
  healthFn?: (baseUrl: string, signal: AbortSignal) => Promise<boolean>;
  /** Injectable sleep, used for startup polling and graceful-stop timeout. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Injectable setInterval — tests capture the callback to fire health checks manually. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (id: unknown) => void;
  /** How often to poll /api/tags while the plugin is loaded. Default: 30 000 ms. */
  healthCheckIntervalMs?: number;
  /** How long to wait for Ollama to come up after spawn. Default: 10 000 ms. */
  startupTimeoutMs?: number;
  /** How long to wait for SIGTERM before sending SIGKILL. Default: 5 000 ms. */
  gracefulStopMs?: number;
}

export class OllamaLifecycle {
  private readonly baseUrl: string;
  private readonly ollamaCmd: string;
  private readonly log: (line: string) => void;
  private readonly _onStatusChange: (s: OllamaStatus) => void;
  private readonly spawnFn: NonNullable<OllamaLifecycleDeps["spawnFn"]>;
  private readonly healthFn: NonNullable<OllamaLifecycleDeps["healthFn"]>;
  private readonly sleepFn: NonNullable<OllamaLifecycleDeps["sleepFn"]>;
  private readonly setIntervalFn: NonNullable<OllamaLifecycleDeps["setIntervalFn"]>;
  private readonly clearIntervalFn: NonNullable<OllamaLifecycleDeps["clearIntervalFn"]>;
  private readonly healthCheckIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private readonly gracefulStopMs: number;

  private child: ChildProcessHandle | null = null;
  private spawnedByPlugin = false;
  private consecutiveFailures = 0;
  private _status: OllamaStatus = "detecting";
  private healthTimer: unknown = null;
  private stopping = false;
  private _inFlight = false;

  constructor(deps: OllamaLifecycleDeps = {}) {
    this.baseUrl = deps.baseUrl ?? "http://127.0.0.1:11434";
    this.ollamaCmd = deps.ollamaCmd ?? "ollama";
    this.log = deps.log ?? ((l) => console.log(l));
    this._onStatusChange = deps.onStatusChange ?? (() => {});
    this.spawnFn = deps.spawnFn ?? defaultSpawn;
    this.healthFn = deps.healthFn ?? defaultHealth;
    this.sleepFn = deps.sleepFn ?? defaultSleep;
    this.setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
    this.healthCheckIntervalMs = deps.healthCheckIntervalMs ?? 30_000;
    this.startupTimeoutMs = deps.startupTimeoutMs ?? 10_000;
    this.gracefulStopMs = deps.gracefulStopMs ?? 5_000;
  }

  get status(): OllamaStatus {
    return this._status;
  }

  /** True when a spawn or restart is in progress. UI disables the Restart button. */
  get inFlight(): boolean {
    return this._inFlight;
  }

  /**
   * Detect and connect to Ollama on plugin load (#24).
   * - Already running → attach without spawning.
   * - Not running → spawn and wait up to startupTimeoutMs for /api/tags.
   */
  async start(): Promise<void> {
    this.stopping = false;
    const alreadyUp = await this.healthFn(this.baseUrl, AbortSignal.timeout(2_000)).catch(() => false);
    if (alreadyUp) {
      this.spawnedByPlugin = false;
      this.setStatus("ready");
      this.startHealthLoop();
      return;
    }
    this.setStatus("starting");
    const spawned = await this.doSpawn();
    if (spawned) this.startHealthLoop();
  }

  /**
   * Stop the health-check loop and, if the plugin owns the process, kill it (#25).
   * Graceful: SIGTERM → 5 s wait → SIGKILL.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.stopHealthLoop();
    if (this.spawnedByPlugin && this.child) {
      await this.gracefulKill(this.child);
      this.child = null;
    }
  }

  /**
   * Restart Ollama. Safe to call from UI — concurrent calls are silently dropped.
   * Takes ownership of the process regardless of spawnedByPlugin history.
   */
  async restart(): Promise<void> {
    if (this._inFlight) return;
    this._inFlight = true;
    try {
      this.setStatus("restarting");
      this.stopHealthLoop();
      if (this.spawnedByPlugin && this.child) {
        await this.gracefulKill(this.child);
        this.child = null;
      }
      const spawned = await this.doSpawn();
      if (spawned) this.startHealthLoop();
    } finally {
      this._inFlight = false;
    }
  }

  private setStatus(s: OllamaStatus): void {
    this._status = s;
    this._onStatusChange(s);
  }

  private async doSpawn(): Promise<boolean> {
    let childExited = false;
    let child: ChildProcessHandle;

    try {
      child = this.spawnFn(this.ollamaCmd, ["serve"], {
        env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11434" },
        detached: false,
        stdio: "pipe",
      });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "ENOENT" || code === "EACCES") {
        this.setStatus("not_installed");
      } else {
        this.log(`[ollama] spawn error: ${String(err)}`);
        this.setStatus("not_responding");
      }
      return false;
    }

    this.child = child;
    this.spawnedByPlugin = true;

    child.stdout?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) this.log(`[ollama] ${line}`);
      }
    });
    child.stderr?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) this.log(`[ollama] ${line}`);
      }
    });
    child.once("exit", (code) => {
      this.log(`[ollama] process exited with code ${code ?? "null"}`);
      childExited = true;
      if (this._status === "starting" || this._status === "restarting") {
        this.setStatus("not_responding");
      }
    });

    const up = await this.waitForHealth(this.startupTimeoutMs, () => childExited);
    if (up) {
      this.setStatus("ready");
    } else if (!childExited) {
      this.setStatus("not_responding");
    }
    return true;
  }

  private async waitForHealth(timeoutMs: number, isExited: () => boolean): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (isExited() || this.stopping) return false;
      try {
        const ok = await this.healthFn(this.baseUrl, AbortSignal.timeout(1_000));
        if (ok) return true;
      } catch { /* keep polling */ }
      if (Date.now() >= deadline) return false;
      await this.sleepFn(500);
    }
  }

  private startHealthLoop(): void {
    this.stopHealthLoop();
    this.consecutiveFailures = 0;
    this.healthTimer = this.setIntervalFn(async () => {
      if (this.stopping || this._inFlight) return;
      try {
        const ok = await this.healthFn(this.baseUrl, AbortSignal.timeout(5_000));
        if (ok) {
          if (this.consecutiveFailures > 0) {
            this.consecutiveFailures = 0;
            if (this._status === "not_responding") this.setStatus("ready");
          }
        } else {
          this.recordFailure();
        }
      } catch {
        this.recordFailure();
      }
    }, this.healthCheckIntervalMs);
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3 && this._status !== "not_responding") {
      this.setStatus("not_responding");
    }
  }

  private stopHealthLoop(): void {
    if (this.healthTimer !== null) {
      this.clearIntervalFn(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async gracefulKill(child: ChildProcessHandle): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      child.once("exit", () => {
        done = true;
        resolve();
      });
      child.kill("SIGTERM");
      this.sleepFn(this.gracefulStopMs).then(() => {
        if (!done) {
          child.kill("SIGKILL");
          resolve();
        }
      });
    });
  }
}

// ── Default implementations (production only) ────────────────────────────────

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: Record<string, unknown>,
): ChildProcessHandle {
  return nodeSpawn(cmd, args, {
    env: opts.env as NodeJS.ProcessEnv,
    detached: opts.detached as boolean | undefined,
    stdio: "pipe",
  }) as unknown as ChildProcessHandle;
}

async function defaultHealth(baseUrl: string, signal: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal });
    return res.ok;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
