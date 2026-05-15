import { execSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildLayrrCommitMessage } from './commit-message.js';

function readContextTag(projectRoot: string): string {
  try {
    const ctxPath = join(projectRoot, '.layrr', 'context.md');
    if (!existsSync(ctxPath)) return '';
    const content = readFileSync(ctxPath, 'utf-8');
    const tagMatch = content.match(/- Tag: `<(.*?)>`/);
    const textMatch = content.match(/- Text: "(.*?)"/);
    const tag = tagMatch ? tagMatch[1] : '';
    const text = textMatch ? textMatch[1] : '';
    if (text) return `<${tag}> "${text.slice(0, 40)}"`;
    if (tag) return `<${tag}>`;
    return '';
  } catch {
    return '';
  }
}

function buildAutoCommitMessage(
  projectRoot: string,
  changed: string[],
  instruction?: string,
): string {
  const normalizedInstruction = (instruction || '').trim().replace(/\s+/g, ' ');
  if (normalizedInstruction) {
    return buildLayrrCommitMessage(normalizedInstruction);
  }

  const tag = readContextTag(projectRoot);
  const fileList = changed.slice(0, 3).join(', ');
  const suffix = changed.length > 3 ? ` +${changed.length - 3} more` : '';
  return tag
    ? `[layrr] ${tag} — ${fileList}${suffix}`
    : `[layrr] ${fileList}${suffix}`;
}

export function autoCommit(projectRoot: string, instruction?: string): boolean {
  try {
    const tracked = execSync('git diff --name-only', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    const changed = [
      ...tracked.split('\n').filter(Boolean),
      ...untracked.split('\n').filter(Boolean),
    ];
    if (changed.length === 0) return false;

    spawnSync('git', ['add', '--', ...changed], {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    const msg = buildAutoCommitMessage(projectRoot, changed, instruction);

    spawnSync('git', ['commit', '--no-verify', '-m', msg], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export function hasUncommittedChanges(projectRoot: string): boolean {
  try {
    const status = execSync('git status --porcelain', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}
