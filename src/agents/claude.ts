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
    const result = spawnSync(claudeBin, ['--version'], {
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

    // Try graceful termination first
    proc.kill('SIGTERM');

    // Wait up to 2 seconds for process to exit
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (proc.killed) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      // Force kill after 2 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        if (!proc.killed) {
          proc.kill('SIGKILL');
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
        ...getClaudeBaseArgs(),
        '--session-id',
        this.sessionId,
        '--no-session-persistence',
        '-p',
        prompt,
      ];

      const proc = spawn(claudeBin, args, {
        cwd: this.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
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
        proc.kill('SIGKILL');
        resolve({ success: false, message: 'Edit timed out after 60 seconds' });
      }, 60000);
    });
  }
}
