import { L } from './constants';
import { toastIn, toastOut, barIn } from './animate';

export function createElements() {
  const root = document.createElement('div');
  root.className = `${L}-root`;
  document.body.appendChild(root);

  const dim = document.createElement('div');
  dim.id = `${L}-dim`;
  root.appendChild(dim);

  const hl = document.createElement('div');
  hl.id = `${L}-hl`;
  root.appendChild(hl);

  const label = document.createElement('div');
  label.id = `${L}-label`;
  root.appendChild(label);

  const toasts = document.createElement('div');
  toasts.id = `${L}-toasts`;
  root.appendChild(toasts);

  const bar = document.createElement('div');
  bar.id = `${L}-bar`;
  bar.innerHTML = `
    <div class="${L}-panel">
      <div class="${L}-ph">
        <div class="${L}-pb"><i class="icon-grip-vertical"></i> Edit <span class="${L}-mode-tag"></span></div>
        <button class="${L}-px"><i class="icon-x"></i></button>
      </div>
      <div class="${L}-ei">
        <div class="${L}-et"></div>
        <div class="${L}-ex"></div>
        <div class="${L}-ep"></div>
      </div>
      <div id="${L}-terminal-container" class="${L}-terminal-container"></div>
      <div class="${L}-ia">
        <div class="${L}-ir">
          <textarea class="${L}-in" placeholder="Describe the change you want to make"></textarea>
          <button class="${L}-sb" aria-label="Send edit request">
            <span class="${L}-st"><i class="icon-arrow-up"></i></span>
            <span class="${L}-sp"></span>
          </button>
        </div>
      </div>
      <div class="${L}-hn"><span><kbd>Click</kbd> to select</span><span><kbd>⌘ Esc</kbd> close</span></div>
    </div>
    <div id="${L}-history">
      <div class="${L}-hh"><span class="${L}-hh-title"><i class="icon-grip-vertical"></i><span>History</span></span></div>
      <div class="${L}-he-empty">No edits yet</div>
    </div>
    <div class="${L}-toolbar">
      <div class="${L}-bd"><i class="icon-grip-vertical"></i></div>
      <button class="${L}-bb ${L}-bbr active" data-tip="Browse"><i class="icon-mouse-pointer-2"></i></button>
      <button class="${L}-bb ${L}-bbe" data-tip="Edit"><i class="icon-square-dashed-mouse-pointer"></i></button>
      <button class="${L}-bb ${L}-bhi" data-tip="History"><i class="icon-clock"></i></button>
      <button class="${L}-bb ${L}-bgrv" data-tip="Revert"><i class="icon-undo"></i></button>
      <button class="${L}-bb ${L}-bgcm" data-tip="Commit"><i class="icon-git-commit"></i></button>
    </div>
  `;
  root.appendChild(bar);
  barIn(bar);

  const panel = bar.querySelector(`.${L}-panel`) as HTMLElement;

  return { root, dim, hl, label, panel, toasts, bar };
}

export function isOwn(el: HTMLElement) {
  return !!el.closest(`.${L}-root`);
}

export function toast(
  msg: string,
  type: 'success' | 'error' | 'info' = 'info',
) {
  const c = document.getElementById(`${L}-toasts`);
  if (!c) return;
  const el = document.createElement('div');
  el.className = `${L}-toast ${type}`;
  const ic =
    type === 'success'
      ? 'icon-circle-check'
      : type === 'error'
        ? 'icon-circle-x'
        : 'icon-info';
  el.innerHTML = `<i class="${ic}"></i><span>${escapeHtml(msg)}</span>`;
  c.appendChild(el);
  toastIn(el);
  setTimeout(() => {
    toastOut(el).then(() => el.remove());
  }, 3000);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
