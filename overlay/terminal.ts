import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const MIN_TERMINAL_COLS = 40;
const MIN_TERMINAL_ROWS = 10;
const FAST_RESIZE_THRESHOLD_MS = 200;
const RESIZE_DEBOUNCE_MS = 50;

let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
let lastResizeTime = 0;
let lastCols = 0;
let lastRows = 0;
let ro: ResizeObserver | null = null;
let currentContainer: HTMLElement | null = null;

export function getTerminal() {
  return term;
}

export function getFitAddon() {
  return fitAddon;
}

function canFitTerminal(container: HTMLElement | null | undefined) {
  return !!container && container.offsetParent !== null && container.clientWidth > 0;
}

function safeFitTerminal() {
  try {
    fitAddon?.fit();
  } catch {}
}

export function setupTerminal(
  container: HTMLElement,
  onInput: (data: string) => void,
  onResize: (cols: number, rows: number) => void,
) {
  if (term) {
    if (term.element && term.element.parentElement !== container) {
      container.appendChild(term.element);
      if (ro && currentContainer) {
        ro.unobserve(currentContainer);
      }
      currentContainer = container;
      if (ro) ro.observe(container);
      setTimeout(() => fitTerminal(), 0);
    }
    return;
  }

  term = new Terminal({
    fontFamily: "'Geist Mono', monospace",
    fontSize: 13,
    cursorBlink: true,
    theme: {
      background: '#09090b',
    },
    allowProposedApi: true,
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  term.onData((data: string) => {
    onInput(data);
  });

  term.onResize((size: { cols: number; rows: number }) => {
    if (size.cols < MIN_TERMINAL_COLS || size.rows < MIN_TERMINAL_ROWS) return;

    const now = Date.now();
    const isSameSize = size.cols === lastCols && size.rows === lastRows;
    const isTooFast = now - lastResizeTime < FAST_RESIZE_THRESHOLD_MS;

    if (isSameSize) return;

    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(
      () => {
        lastResizeTime = Date.now();
        lastCols = size.cols;
        lastRows = size.rows;
        onResize(size.cols, size.rows);
      },
      isTooFast ? FAST_RESIZE_THRESHOLD_MS : RESIZE_DEBOUNCE_MS,
    );
  });

  currentContainer = container;
  ro = new ResizeObserver(() => {
    if (canFitTerminal(currentContainer)) {
      safeFitTerminal();
    }
  });
  ro.observe(currentContainer);

  window.addEventListener('resize', () => {
    if (fitAddon) {
      safeFitTerminal();
    }
  });
}

export function focusTerminal() {
  term?.focus();
}

export function fitTerminal() {
  if (term && fitAddon) {
    const container = term.element?.parentElement;
    if (canFitTerminal(container)) {
      safeFitTerminal();
    }
  }
}
