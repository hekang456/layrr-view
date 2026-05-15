import type {
  Agent,
  AgentName,
  AgentOptions,
  AgentCheckResult,
  AgentTerminalLaunchSpec,
} from './base.js';
import { PUBLIC_AGENTS } from './base.js';
import {
  ClaudeAgent,
  checkClaude,
  getClaudeTerminalLaunchSpec,
} from './claude.js';
import { CodexAgent, checkCodex, getCodexTerminalLaunchSpec } from './codex.js';
import {
  PiMonoAgent,
  checkPiMono,
  getPiMonoTerminalLaunchSpec,
} from './pi-mono.js';

export type { Agent, AgentName, AgentOptions };

interface AgentDefinition {
  name: AgentName;
  displayName: string;
  create: (opts: AgentOptions) => Agent;
  check: () => AgentCheckResult;
  installHint: string;
  authHint: string;
  terminalLaunch: () => AgentTerminalLaunchSpec;
}

const AGENTS: Record<AgentName, AgentDefinition> = {
  claude: {
    name: 'claude',
    displayName: 'Claude Code',
    create: (opts) => new ClaudeAgent(opts),
    check: checkClaude,
    installHint: 'npm install -g @anthropic-ai/claude-code',
    authHint: `  Authenticate using one of these methods:

    • Bedrock:  claude login --bedrock
    • SSO:      claude login --sso
    • API key:  claude login`,
    terminalLaunch: getClaudeTerminalLaunchSpec,
  },
  codex: {
    name: 'codex',
    displayName: 'Codex CLI',
    create: (opts) => new CodexAgent(opts),
    check: checkCodex,
    installHint: 'npm install -g @openai/codex',
    authHint: `  Set your OpenAI API key:

    export OPENAI_API_KEY=<your-key>`,
    terminalLaunch: getCodexTerminalLaunchSpec,
  },
  'pi-mono': {
    name: 'pi-mono',
    displayName: 'Pi Mono',
    create: (opts) => new PiMonoAgent(opts),
    check: checkPiMono,
    installHint: 'Bundled — just configure an LLM provider API key',
    authHint: `  Set your OpenRouter API key:

    export OPENROUTER_API_KEY=<key>`,
    terminalLaunch: getPiMonoTerminalLaunchSpec,
  },
};

const ALL_AGENTS = Object.values(AGENTS).map(({ name, displayName }) => ({
  name,
  displayName,
}));

// Public agents shown in CLI picker and help text
export const AGENT_LIST = ALL_AGENTS.filter((a) =>
  PUBLIC_AGENTS.includes(a.name),
);

export function createAgent(name: AgentName, opts: AgentOptions): Agent {
  return AGENTS[name].create(opts);
}

export function checkAgent(name: AgentName): AgentCheckResult {
  return AGENTS[name].check();
}

export function getAgentDisplayName(name: AgentName): string {
  return AGENTS[name].displayName;
}

export function getInstallHint(name: AgentName): string {
  return AGENTS[name].installHint;
}

export function getAuthHint(name: AgentName): string {
  return AGENTS[name].authHint;
}

export function getAgentTerminalLaunchSpec(
  name: AgentName,
): AgentTerminalLaunchSpec {
  return AGENTS[name].terminalLaunch();
}

export function isValidAgent(name: string): name is AgentName {
  return name in AGENTS;
}
