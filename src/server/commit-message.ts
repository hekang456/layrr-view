export const LAYRR_COMMIT_PREFIX = '[layrr] ';
export const LAYRR_DISPLAY_PREFIX = '【layrr】';

export function buildLayrrCommitMessage(instruction: string): string {
  const normalizedInstruction = instruction.trim().replace(/\s+/g, ' ');
  return `${LAYRR_COMMIT_PREFIX}${normalizedInstruction.slice(0, 72)}`;
}

export function isLayrrCommitMessage(message: string): boolean {
  return message.startsWith(LAYRR_COMMIT_PREFIX);
}

export function stripLayrrCommitPrefix(message: string): string {
  return isLayrrCommitMessage(message)
    ? message.slice(LAYRR_COMMIT_PREFIX.length)
    : message;
}

export function formatLayrrCommitDisplay(message: string): string {
  return isLayrrCommitMessage(message)
    ? `${LAYRR_DISPLAY_PREFIX}${stripLayrrCommitPrefix(message)}`
    : message;
}
