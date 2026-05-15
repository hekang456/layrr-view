import * as pty from 'node-pty';
import { spawnSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import type { AgentName, AgentTerminalLaunchSpec } from '../agents/base.js';
import { getAgentTerminalLaunchSpec } from '../agents/index.js';
import type { WebSocket } from 'ws';
import { autoCommit, hasUncommittedChanges } from './git-auto.js';

const DEFAULT_PTY_COLS = 80;
const DEFAULT_PTY_ROWS = 24;
const MIN_PTY_COLS = 40;
const MIN_PTY_ROWS = 10;
const AUTO_COMMIT_DELAY_MS = 3000;
const LAUNCH_TIMEOUT_MS = 3000;

export type PtyInputMessage = {
  type: 'pty-input';
  data: string;
};

export type PtyResizeMessage = {
  type: 'pty-resize';
  cols?: number;
  rows?: number;
};

export type PtyMessage = PtyInputMessage | PtyResizeMessage;

let ptyProcess: pty.IPty | null = null;
let currentWs: WebSocket | null = null;
let projectRoot: string = '';
let autoCommitTimer: ReturnType<typeof setTimeout> | null = null;
let lastInjectedLen = 0;
let agentLaunched = false;
let pendingLaunch: AgentName | null = null;
let wsCloseTimer: ReturnType<typeof setTimeout> | null = null;
let injectQueue: string[] = [];
let injectTimer: ReturnType<typeof setTimeout> | null = null;
let ptyOutputBuffer = '';
let currentInputBuffer = '';
let lastTerminalInstruction = '';
const MAX_BUFFER_SIZE = 100000;

function resolveShell(): string {
  if (process.env.SHELL) {
    if (
      process.env.SHELL.includes('bash') &&
      os.platform() === 'darwin' &&
      fs.existsSync('/bin/zsh')
    ) {
      return '/bin/zsh';
    }
    return process.env.SHELL;
  }
  if (os.platform() === 'darwin') {
    if (fs.existsSync('/bin/zsh')) return '/bin/zsh';
  }
  return os.platform() === 'win32' ? 'powershell.exe' : 'bash';
}

export function killPty() {
  const proc = ptyProcess;
  // Reset state first to prevent race conditions with callbacks
  ptyProcess = null;
  agentLaunched = false;
  pendingLaunch = null;
  lastInjectedLen = 0;
  injectQueue = [];
  ptyOutputBuffer = '';
  currentInputBuffer = '';
  lastTerminalInstruction = '';
  shellReady = false;
  if (launchTimeout) {
    clearTimeout(launchTimeout);
    launchTimeout = null;
  }
  if (injectTimer) {
    clearTimeout(injectTimer);
    injectTimer = null;
  }
  if (autoCommitTimer) {
    clearTimeout(autoCommitTimer);
    autoCommitTimer = null;
  }
  if (proc) {
    try {
      proc.kill();
    } catch {}
  }
}

function scheduleAutoCommit() {
  if (autoCommitTimer) clearTimeout(autoCommitTimer);
  autoCommitTimer = setTimeout(() => {
    if (!projectRoot) return;
    if (hasUncommittedChanges(projectRoot)) {
      const ok = autoCommit(projectRoot, lastTerminalInstruction);
      if (ok) {
        console.log('  ✓ Auto-committed terminal edit');
        notifyHistoryUpdated('terminal-edit');
      }
    }
    autoCommitTimer = null;
  }, AUTO_COMMIT_DELAY_MS);
}

function extractInstructionFromBuffer(buffer: string): string {
  const instruction = buffer
    .trim()
    .replace(/^@\.layrr\/context\.md\s*/i, '')
    .replace(/^\[Not found:[^\]]+\]\s*/i, '')
    .trim();

  // Some terminal/IME flows can leave a stray leading "[" without a closing pair.
  // Treat that as input noise, but keep legitimate bracketed instructions intact.
  if (instruction.startsWith('[') && !instruction.slice(1, 24).includes(']')) {
    return instruction.slice(1).trimStart();
  }

  return instruction;
}

function trackTerminalInput(data: string) {
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      const instruction = extractInstructionFromBuffer(currentInputBuffer);
      if (instruction) {
        lastTerminalInstruction = instruction;
      }
      currentInputBuffer = '';
      continue;
    }

    if (ch === '\x7f' || ch === '\b') {
      currentInputBuffer = currentInputBuffer.slice(0, -1);
      continue;
    }

    if (ch >= ' ') {
      currentInputBuffer += ch;
    }
  }
}

function commandExists(cmd: string): boolean {
  try {
    const binary = os.platform() === 'win32' ? 'where' : 'which';
    const result = spawnSync(binary, [cmd], {
      stdio: 'ignore',
      env: process.env,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

let shellReady = false;
let launchTimeout: ReturnType<typeof setTimeout> | null = null;

function appendToOutputBuffer(data: string) {
  ptyOutputBuffer += data;
  if (ptyOutputBuffer.length > MAX_BUFFER_SIZE) {
    ptyOutputBuffer = ptyOutputBuffer.slice(
      ptyOutputBuffer.length - MAX_BUFFER_SIZE,
    );
  }
}

function sendPtyEvent(event: Record<string, unknown>) {
  if (currentWs && currentWs.readyState === currentWs.OPEN) {
    currentWs.send(JSON.stringify(event));
  }
}

function writeTerminalOutput(data: string) {
  appendToOutputBuffer(data);
  sendPtyEvent({ type: 'pty-output', data });
}

function emitTerminalError(error: string, message: string) {
  sendPtyEvent({ type: 'pty-error', error, message });
}

function notifyHistoryUpdated(source: 'terminal-edit') {
  sendPtyEvent({ type: 'history-updated', source });
}

function renderLaunchBanner(label: string): string {
  return (
    '\r\n\x1b[90m' +
    '─'.repeat(60) +
    '\x1b[0m\r\n' +
    `\x1b[34m⠋ ${label}\x1b[0m\r\n` +
    '\x1b[90m' +
    '─'.repeat(60) +
    '\x1b[0m\r\n\r\n'
  );
}

function renderInfoMessage(message: string): string {
  return `\r\n\x1b[36m[layrr]\x1b[0m ${message}\r\n`;
}

function quoteShellArg(value: string): string {
  if (os.platform() === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildShellCommand(spec: AgentTerminalLaunchSpec): string {
  if (spec.kind !== 'command') {
    return '';
  }

  const args = spec.args || [];
  if (os.platform() === 'win32') {
    return [
      `& ${quoteShellArg(spec.command)}`,
      ...args.map(quoteShellArg),
    ].join(' ');
  }
  return [quoteShellArg(spec.command), ...args.map(quoteShellArg)].join(' ');
}

function launchAgentNow(agentName: AgentName) {
  if (!ptyProcess) return;
  const launchSpec = getAgentTerminalLaunchSpec(agentName);

  console.log(`[layrr] Launching ${agentName} terminal session`);
  writeTerminalOutput(renderLaunchBanner(launchSpec.startupLabel));

  if (launchSpec.kind === 'command') {
    if (launchSpec.command === 'codex' && !commandExists(launchSpec.command)) {
      const notFoundMessage =
        launchSpec.notFoundMessage || `${launchSpec.command} not found`;
      console.error(`[layrr] ${notFoundMessage}`);
      writeTerminalOutput(renderInfoMessage(notFoundMessage));
      emitTerminalError('not-found', notFoundMessage);
    } else {
      ptyProcess.write(`${buildShellCommand(launchSpec)}\r`);
    }
  } else {
    writeTerminalOutput(renderInfoMessage(launchSpec.message));
  }

  pendingLaunch = null;
  flushInjectQueue();
}

function tryLaunchAgent(agentName: AgentName) {
  if (agentLaunched) return;
  pendingLaunch = agentName;
  agentLaunched = true;

  if (shellReady) {
    launchAgentNow(agentName);
  } else {
    if (launchTimeout) clearTimeout(launchTimeout);
    launchTimeout = setTimeout(() => {
      launchTimeout = null;
      if (pendingLaunch) {
        launchAgentNow(pendingLaunch);
      }
    }, LAUNCH_TIMEOUT_MS);
  }
}

function flushInjectQueue() {
  if (!ptyProcess || injectQueue.length === 0) return;
  while (injectQueue.length > 0) {
    const text = injectQueue.shift()!;
    doInject(text);
  }
}

function spawnPty(agentName?: AgentName) {
  const shell = resolveShell();

  try {
    const env = { ...process.env } as Record<string, string>;

    ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
      cwd: projectRoot,
      env,
    });
  } catch (e) {
    console.error('[layrr] Failed to spawn PTY:', e);
    ptyProcess = null;
    agentLaunched = false;
    if (currentWs && currentWs.readyState === currentWs.OPEN) {
      currentWs.send(
        JSON.stringify({
          type: 'pty-output',
          data: '\r\n\x1b[31m[layrr] Terminal unavailable: failed to spawn shell.\x1b[0m\r\n',
        }),
      );
    }
    return;
  }

  const currentProc = ptyProcess;

  currentProc.onData((data) => {
    appendToOutputBuffer(data);

    if (!shellReady) {
      const stripped = data
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1b\].*?\x07/g, '')
        .replace(/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g, '')
        .replace(/\r/g, '');
      if (
        /[#$%>]\s*$/.test(stripped) ||
        stripped.includes('$ ') ||
        stripped.includes('% ')
      ) {
        shellReady = true;
        console.log('[layrr] Shell ready detected, launching agent');
        if (pendingLaunch) {
          if (launchTimeout) {
            clearTimeout(launchTimeout);
            launchTimeout = null;
          }
          launchAgentNow(pendingLaunch);
        }
      }
    }

    if (currentWs && currentWs.readyState === currentWs.OPEN) {
      sendPtyEvent({ type: 'pty-output', data });
      // Detect rate limit errors and notify user
      if (data.includes('Rate limit exceeded') || data.includes('429')) {
        emitTerminalError(
          'rate-limit',
          'API rate limit exceeded. Please wait a moment and try again.',
        );
      }
    }
    scheduleAutoCommit();
  });

  currentProc.onExit(({ exitCode, signal }) => {
    if (ptyProcess === currentProc) {
      ptyProcess = null;
      agentLaunched = false;
    }
    if (currentWs && currentWs.readyState === currentWs.OPEN) {
      currentWs.send(JSON.stringify({ type: 'pty-exit', exitCode, signal }));
    }
  });

  if (agentName) {
    tryLaunchAgent(agentName);
  }
}

export function initPty(root: string, agentName?: AgentName) {
  projectRoot = root;
  if (!ptyProcess) {
    spawnPty(agentName);
  }
}

export function attachWs(ws: WebSocket) {
  if (wsCloseTimer) {
    clearTimeout(wsCloseTimer);
    wsCloseTimer = null;
  }

  currentWs = ws;

  ws.on('close', () => {
    if (currentWs === ws) {
      currentWs = null;
    }
  });
}

export function getPtyBuffer() {
  return ptyOutputBuffer;
}

export function handlePtyMessage(msg: PtyMessage) {
  if (!ptyProcess) return;

  switch (msg.type) {
    case 'pty-input':
      if (typeof msg.data === 'string') {
        trackTerminalInput(msg.data);
      }
      ptyProcess.write(msg.data);
      break;
    case 'pty-resize': {
      const cols =
        typeof msg.cols === 'number'
          ? Math.max(MIN_PTY_COLS, Math.floor(msg.cols))
          : DEFAULT_PTY_COLS;
      const rows =
        typeof msg.rows === 'number'
          ? Math.max(MIN_PTY_ROWS, Math.floor(msg.rows))
          : DEFAULT_PTY_ROWS;
      try {
        ptyProcess.resize(cols, rows);
      } catch (e) {
        console.error('Failed to resize PTY', e);
      }
      break;
    }
  }
}

export function writeToPty(data: string) {
  if (ptyProcess) {
    ptyProcess.write(data);
  }
}

function doInject(text: string) {
  if (!ptyProcess) return;
  // Clear previous injection by sending backspace characters
  if (lastInjectedLen > 0) {
    ptyProcess.write('\x7f'.repeat(lastInjectedLen));
  }
  ptyProcess.write(text);
  lastInjectedLen = text.length;
  currentInputBuffer = text;
}

export function injectContext(text: string) {
  if (!ptyProcess) return;

  // If agent is still launching, queue the injection
  if (pendingLaunch) {
    injectQueue.push(text);
    // Set up a safety timer to flush queue even if launch signal is missed
    if (!injectTimer) {
      injectTimer = setTimeout(() => {
        injectTimer = null;
        flushInjectQueue();
      }, LAUNCH_TIMEOUT_MS);
    }
    return;
  }

  doInject(text);
}
