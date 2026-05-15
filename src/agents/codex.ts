import type { PendingEditRequest } from '../server/edit-queue.js';
import type {
  Agent,
  AgentOptions,
  AgentCheckResult,
  AgentTerminalLaunchSpec,
} from './base.js';
import { checkBinary, spawnAgent } from './base.js';
import { buildPrompt } from './prompt.js';

const AUTH_KEYWORDS = ['api key', 'auth', 'openai', 'sign in', 'unauthorized'];

function getCodexFullAutoArgs(): string[] {
  return ['--full-auto'];
}

function getCodexExecArgs(prompt: string): string[] {
  return ['exec', ...getCodexFullAutoArgs(), prompt];
}

export function getCodexTerminalLaunchSpec(): AgentTerminalLaunchSpec {
  return {
    kind: 'command',
    command: 'codex',
    args: getCodexFullAutoArgs(),
    startupLabel: 'Starting Codex...',
    notFoundMessage:
      'Codex CLI not found. Install: npm install -g @openai/codex',
  };
}

export function checkCodex(): AgentCheckResult {
  return checkBinary('codex', ['--version'], AUTH_KEYWORDS);
}

export class CodexAgent implements Agent {
  readonly name = 'codex' as const;
  readonly displayName = 'Codex CLI';
  private projectRoot: string;

  constructor(opts: AgentOptions) {
    this.projectRoot = opts.projectRoot;
  }

  async applyEdit(
    request: PendingEditRequest,
  ): Promise<{ success: boolean; message: string }> {
    const prompt = buildPrompt(request);
    return spawnAgent('codex', getCodexExecArgs(prompt), this.projectRoot);
  }
}
