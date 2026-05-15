export const PAIR_UI_MODES = ['terminal', 'panel'] as const;

export type PairUIMode = (typeof PAIR_UI_MODES)[number];

export const DEFAULT_UI_MODE: PairUIMode = 'terminal';

export function isValidUIMode(mode: string): mode is PairUIMode {
  return (PAIR_UI_MODES as readonly string[]).includes(mode);
}
