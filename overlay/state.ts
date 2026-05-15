import { L } from './constants';
import type { SourceInfo } from './source';

export type Mode = 'browse' | 'edit';
export type EditUIMode = 'terminal' | 'panel';

type LayrrWindow = Window & {
  __LAYRR_MODE__?: EditUIMode;
};

type PersistedState = {
  mode?: Mode;
  editCount?: number;
  lastEditTimestamp?: number;
  historyOpen?: boolean;
  barPos?: {
    left: string;
    top: string;
  };
};

const SS_KEY = '__layrr_state';
const layrrWindow = window as LayrrWindow;

function isEditUIMode(value: unknown): value is EditUIMode {
  return value === 'terminal' || value === 'panel';
}

function getInitialEditUIMode(): EditUIMode {
  return isEditUIMode(layrrWindow.__LAYRR_MODE__)
    ? layrrWindow.__LAYRR_MODE__
    : 'terminal';
}

export function loadState(): PersistedState {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as PersistedState;
      }
    }
  } catch {}
  return {};
}

export function saveState(
  mode: Mode,
  editCount: number,
  lastEditTimestamp: number,
) {
  try {
    const bar = document.getElementById(`${L}-bar`);
    const histOpen =
      document.getElementById(`${L}-history`)?.classList.contains('open') ||
      false;
    const state: PersistedState = {
      mode,
      editCount,
      lastEditTimestamp,
      historyOpen: histOpen,
    };
    if (bar) {
      const s = bar.style;
      if (s.left && s.top) {
        state.barPos = { left: s.left, top: s.top };
      }
    }
    sessionStorage.setItem(SS_KEY, JSON.stringify(state));
  } catch {}
}

// Shared mutable state
export const app = {
  mode: 'browse' as Mode,
  editUIMode: getInitialEditUIMode(),
  hoveredEl: null as HTMLElement | null,
  selectedEl: null as HTMLElement | null,
  selectedEls: [] as HTMLElement[],
  multiHighlights: [] as HTMLElement[],
  selectedSourceInfo: null as SourceInfo | null,
  sourceInfoLoading: false,
  multiSourceInfoMap: new Map<HTMLElement, SourceInfo | null>(),
  ws: null as WebSocket | null,
  connected: false,
  editCount: 0,
  lastEdit: null as { tagName: string; instruction: string } | null,
  historyPage: 0,
  hlEl: null as HTMLElement | null,
  labelEl: null as HTMLElement | null,
  modeTagEl: null as HTMLElement | null,
  panelEl: null as HTMLElement | null,
  barEl: null as HTMLElement | null,
  dimEl: null as HTMLElement | null,
  inputAreaEl: null as HTMLElement | null,
  terminalContainer: null as HTMLElement | null,
  inputEl: null as HTMLTextAreaElement | null,
  sendBtnEl: null as HTMLButtonElement | null,
  pollTimer: null as ReturnType<typeof setInterval> | null,
  spinnerTimeout: null as ReturnType<typeof setTimeout> | null,
  lastEditTimestamp: 0,
  previewingHash:
    sessionStorage.getItem('__layrr_preview') || (null as string | null),
  ptyBuffer: [] as string[],
  hasSeenPtyOutput: false,
  hasLoadedPtySnapshot: false,
};

export function initState(saved: PersistedState) {
  app.mode = saved.mode || 'browse';
  app.editCount = saved.editCount || 0;
  app.lastEditTimestamp = saved.lastEditTimestamp || 0;
}

export function save() {
  saveState(app.mode, app.editCount, app.lastEditTimestamp);
}
