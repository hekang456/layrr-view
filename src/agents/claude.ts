import { spawn, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import type { PendingEditRequest } from '../server/edit-queue.js';
import type {
  Agent,
  AgentOptions,
  AgentCheckResult,
  AgentTerminalLaunchSpec,
} from './base.js';
import { buildPrompt } from './prompt.js';

const claudeBin = 'claude';

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getClaudeBaseArgs(): string[] {
  return ['--permission-mode', 'acceptEdits'];
}

export function getClaudeTerminalLaunchSpec(): AgentTerminalLaunchSpec {
  return {
    kind: 'command',
    command: claudeBin,
    args: getClaudeBaseArgs(),
    startupLabel: 'Starting Claude...',
  };
}

export function checkClaude(): AgentCheckResult {
  try {
    const result = spawnSync('/bin/sh', ['-c', 'claude --version'], {
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.status === 0) return { ok: true };

    const stderr = result.stderr?.toString() || '';
    const stderrLower = stderr.toLowerCase();
    if (
      stderrLower.includes('auth') ||
      stderrLower.includes('login') ||
      stderrLower.includes('api key') ||
      stderrLower.includes('credentials') ||
      stderrLower.includes('bedrock') ||
      stderrLower.includes('not configured')
    ) {
      return { ok: false, error: 'not-authenticated' };
    }

    return { ok: false, error: `claude exited with code ${result.status}` };
  } catch {
    return { ok: false, error: 'not-found' };
  }
}

export class ClaudeAgent implements Agent {
  readonly name = 'claude' as const;
  readonly displayName = 'Claude Code';
  private sessionId: string;
  private projectRoot: string;
  private currentProc: ReturnType<typeof spawn> | null = null;

  constructor(opts: AgentOptions) {
    this.sessionId = randomUUID();
    this.projectRoot = opts.projectRoot;
  }

  private async killCurrentProc(): Promise<void> {
    if (!this.currentProc) return;

    const proc = this.currentProc;
    this.currentProc = null;

    try {
      process.kill(-proc.pid!, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }

    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (proc.killed) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkInterval);
        if (!proc.killed) {
          try {
            process.kill(-proc.pid!, 'SIGKILL');
          } catch {
            proc.kill('SIGKILL');
          }
        }
        resolve();
      }, 2000);
    });
  }

  async applyEdit(
    request: PendingEditRequest,
  ): Promise<{ success: boolean; message: string }> {
    // Ensure any previous session is fully terminated
    await this.killCurrentProc();

    const prompt = buildPrompt(request);

    return new Promise((resolve) => {
      const args = [
        '--print',
        '--output-format',
        'text',
        '--dangerously-skip-permissions',
        '--session-id',
        this.sessionId,
        '--no-session-persistence',
        '-p',
        prompt,
      ];

      // NOTE: The Claude Code CLI is now distributed as a Bun-compiled native
      // binary. When spawned directly with piped stdio (no TTY), it never
      // writes any output and hangs indefinitely. Wrapping the call in a shell
      // ("/bin/sh -c ...") works around this stdio quirk: the shell handles
      // stdio negotiation correctly and the binary streams output as expected.
      // We must NOT touch the terminal-mode launch spec — that path runs inside
      // a real PTY where the binary already works fine.
      const shellCommand = [claudeBin, ...args.map(quoteShellArg)].join(' ');
      const proc = spawn('/bin/sh', ['-c', shellCommand], {
        cwd: this.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        detached: true,
      });

      this.currentProc = proc;

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        this.currentProc = null;
        if (code === 0) {
          resolve({
            success: true,
            message: stdout.trim().slice(-200) || 'Edit applied',
          });
        } else {
          const err = stderr.trim();
          const errLower = err.toLowerCase();
          if (
            errLower.includes('auth') ||
            errLower.includes('login') ||
            errLower.includes('api key') ||
            errLower.includes('credentials') ||
            errLower.includes('bedrock') ||
            errLower.includes('not configured')
          ) {
            resolve({
              success: false,
              message: 'Claude Code authentication failed. Run: claude login',
            });
          } else {
            resolve({
              success: false,
              message: err.slice(-200) || `Claude exited with code ${code}`,
            });
          }
        }
      });

      proc.on('error', (err) => {
        this.currentProc = null;
        resolve({
          success: false,
          message: `Failed to spawn Claude: ${err.message}`,
        });
      });

      setTimeout(() => {
        if (this.currentProc === proc) {
          this.currentProc = null;
        }
        try {
          process.kill(-proc.pid!, 'SIGKILL');
        } catch {
          proc.kill('SIGKILL');
        }
        resolve({ success: false, message: 'Edit timed out after 60 seconds' });
      }, 60000);
    });
  }
}
