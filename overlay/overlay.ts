type EditUIMode = import('./state').EditUIMode;

type PairRuntime = {
  nextInstanceId: number;
  activeInstanceId: number;
};

type LayrrWindow = Window & {
  __LAYRR_LOADED__?: boolean;
  __LAYRR_RUNTIME__?: PairRuntime;
  __LAYRR_PATH_PREFIX__?: string;
  __LAYRR_MODE__?: EditUIMode;
  __LAYRR_AGENT__?: string;
  __LAYRR_CONNECT_WS__?: unknown;
};

(async function () {
  const layrrWindow = window as LayrrWindow;
  if (layrrWindow.__LAYRR_LOADED__) return;
  layrrWindow.__LAYRR_LOADED__ = true;
  const runtime = (layrrWindow.__LAYRR_RUNTIME__ ||= {
    nextInstanceId: 0,
    activeInstanceId: 0,
  });
  const instanceId = ++runtime.nextInstanceId;
  runtime.activeInstanceId = instanceId;
  let pageUnloading = false;

  function isActiveInstance() {
    return (layrrWindow.__LAYRR_RUNTIME__?.activeInstanceId ?? 0) === instanceId;
  }

  window.addEventListener('beforeunload', () => {
    pageUnloading = true;
    if (runtime.activeInstanceId === instanceId) {
      runtime.activeInstanceId = 0;
    }
  });

  const WS_PORT = location.port; // empty on standard ports (443/80) — that's correct
  // Detect path prefix when accessed via /preview/{slug}/ proxy
  const previewMatch = location.pathname.match(/^(\/preview\/[^/]+)/);
  const PATH_PREFIX = previewMatch ? previewMatch[1] : '';
  layrrWindow.__LAYRR_PATH_PREFIX__ = PATH_PREFIX;

  const { setupTerminal, focusTerminal, fitTerminal, getTerminal } =
    await import('./terminal');

  const { L } = await import('./constants');
  const { ensureStyles } = await import('./styles');
  const { createElements, isOwn, toast } = await import('./elements');
  const { app, loadState, initState, save } = await import('./state');
  const {
    initSourceMapping,
    extractSourceInfo,
    getSourceInfoMeta,
    getAccessibleLabel,
    getCommonAncestor,
    getElementTextPreview,
    getTag,
    getBreadcrumb,
    getSelector,
    posHL,
    posLabel,
  } = await import('./source');
  const { fetchAndRenderHistory, closeHistory } = await import('./history');
  const { revertToPrevious, triggerCommit } = await import('./git');
  const { btnActivate, btnDeactivate, confirmIn, confirmOut, dimIn } =
    await import('./animate');

  // Toolbar button colors (match CSS)
  const BTN = {
    browseBg: 'rgba(228,228,231,.05)',
    browseColor: '#fafafa',
    editBg: 'rgba(250,250,250,.12)',
    editColor: '#fafafa',
    histBg: 'rgba(228,228,231,.05)',
    histColor: '#fafafa',
  };

  type SelectionPattern = 'same-container' | 'same-tag' | 'mixed';
  type SelectionContext = {
    count: number;
    orderedBy: 'selection';
    commonAncestorSelector?: string;
    commonAncestorTag?: string;
    commonBreadcrumb?: string;
    selectionPattern: SelectionPattern;
  };
  type SelectedElementPayload = {
    selector: string;
    tagName: string;
    className: string;
    textContent: string;
    sourceInfo: Awaited<ReturnType<typeof extractSourceInfo>>;
    tagLabel: string;
    breadcrumb: string;
    selectionIndex: number;
    isPrimary: boolean;
    accessibleLabel?: string;
  };

  function isTerminalEditMode() {
    return app.editUIMode === 'terminal';
  }

  function syncModeBadge() {
    if (app.modeTagEl) {
      app.modeTagEl.textContent = app.editUIMode;
    }
  }

  function applyRuntimeConfig(config: {
    uiMode?: EditUIMode;
    agentName?: string;
  }) {
    if (config.uiMode === 'terminal' || config.uiMode === 'panel') {
      app.editUIMode = config.uiMode;
      layrrWindow.__LAYRR_MODE__ = config.uiMode;
      syncModeBadge();
      syncEditSurface();
      // Update hint text (close shortcut differs for terminal mode).
      const hn = app.panelEl?.querySelector(`.${L}-hn`) as HTMLElement | null;
      const closeLabel = app.editUIMode === 'terminal' ? '⌘ Esc' : 'Esc';
      if (hn)
        hn.innerHTML = `<span><kbd>Click</kbd> to select</span><span><kbd>${closeLabel}</kbd> close</span>`;
      if (app.mode === 'edit') {
        if (isTerminalEditMode()) ensureTerminal();
        else focusPanelInput();
      }
    }
    if (typeof config.agentName === 'string') {
      layrrWindow.__LAYRR_AGENT__ = config.agentName;
    }
  }

  function getElementSummary(el: HTMLElement, limit = 100) {
    return (
      getElementTextPreview(el, limit) || getAccessibleLabel(el, limit) || ''
    );
  }

  function getSelectionPattern(elements: HTMLElement[]): SelectionPattern {
    if (elements.length <= 1) return 'mixed';
    const firstParent = elements[0].parentElement;
    if (
      firstParent &&
      elements.every((el) => el.parentElement === firstParent)
    ) {
      return 'same-container';
    }
    const firstTag = elements[0].tagName;
    if (elements.every((el) => el.tagName === firstTag)) {
      return 'same-tag';
    }
    return 'mixed';
  }

  function buildSelectionContext(elements: HTMLElement[]): SelectionContext {
    const commonAncestor = getCommonAncestor(elements);
    return {
      count: elements.length,
      orderedBy: 'selection',
      commonAncestorSelector: commonAncestor
        ? getSelector(commonAncestor)
        : undefined,
      commonAncestorTag: commonAncestor ? getTag(commonAncestor) : undefined,
      commonBreadcrumb: commonAncestor
        ? getBreadcrumb(commonAncestor)
        : undefined,
      selectionPattern: getSelectionPattern(elements),
    };
  }

  function buildSelectedElementPayload(
    el: HTMLElement,
    selectionIndex: number,
    isPrimary: boolean,
  ): SelectedElementPayload {
    return {
      selector: getSelector(el),
      tagName: el.tagName.toLowerCase(),
      className: el.className || '',
      textContent: el.textContent?.trim().slice(0, 100) || '',
      sourceInfo:
        app.multiSourceInfoMap.get(el) ??
        (app.selectedEls.length === 1 ? app.selectedSourceInfo : null),
      tagLabel: getTag(el),
      breadcrumb: getBreadcrumb(el),
      selectionIndex,
      isPrimary,
      accessibleLabel: getAccessibleLabel(el, 100) || undefined,
    };
  }

  function setSendLoading(loading: boolean) {
    const sendBtn = app.sendBtnEl;
    if (!sendBtn) return;
    sendBtn.disabled = loading;
    sendBtn.classList.toggle('loading', loading);
  }

  function focusPanelInput() {
    if (!isTerminalEditMode()) {
      setTimeout(() => app.inputEl?.focus(), 50);
    }
  }

  function syncEditSurface() {
    if (!app.panelEl || !app.terminalContainer || !app.inputAreaEl) return;
    const historyPanel = document.getElementById(`${L}-history`);
    app.panelEl.classList.toggle(
      `${L}-panel-mode-terminal`,
      isTerminalEditMode(),
    );
    app.panelEl.classList.toggle(
      `${L}-panel-mode-panel`,
      !isTerminalEditMode(),
    );
    historyPanel?.classList.toggle(
      `${L}-history-mode-terminal`,
      isTerminalEditMode(),
    );
    historyPanel?.classList.toggle(
      `${L}-history-mode-panel`,
      !isTerminalEditMode(),
    );
    app.terminalContainer.style.display = isTerminalEditMode()
      ? 'flex'
      : 'none';
    app.inputAreaEl.style.display = isTerminalEditMode() ? 'none' : 'flex';
  }

  function activateBrowse(br: HTMLElement, ed: HTMLElement) {
    br.classList.add('active');
    btnActivate(br, BTN.browseBg, BTN.browseColor);
    ed.classList.remove('active');
    btnDeactivate(ed);
  }

  function activateEdit(br: HTMLElement, ed: HTMLElement) {
    br.classList.remove('active');
    btnDeactivate(br);
    ed.classList.add('active');
    btnActivate(ed, BTN.editBg, BTN.editColor);
  }

  function activateHistory(br: HTMLElement, ed: HTMLElement, hi: HTMLElement) {
    br.classList.remove('active');
    btnDeactivate(br);
    ed.classList.remove('active');
    btnDeactivate(ed);
    hi.classList.add('open');
    btnActivate(hi, BTN.histBg, BTN.histColor);
  }

  function deactivateHistory(hi: HTMLElement) {
    hi.classList.remove('open');
    btnDeactivate(hi);
  }

  await initSourceMapping();

  const saved = loadState();
  initState(saved);

  // ---- Panel helpers ----
  let terminalInitialized = false;

  function ensureTerminal() {
    const container = app.terminalContainer;
    if (!container) return;

    if (terminalInitialized) {
      // It might have been detached by a framework re-render, ensure it's attached
      setupTerminal(
        container,
        () => {}, // these callbacks won't be used if it's already set up
        () => {},
      );
      setTimeout(() => fitTerminal(), 0);
      setTimeout(() => focusTerminal(), 50);
      return;
    }
    terminalInitialized = true;

    setupTerminal(
      container,
      (data: string) => {
        if (app.ws?.readyState === WebSocket.OPEN) {
          app.ws.send(JSON.stringify({ type: 'pty-input', data }));
        }
      },
      (cols: number, rows: number) => {
        if (app.ws?.readyState === WebSocket.OPEN) {
          app.ws.send(JSON.stringify({ type: 'pty-resize', cols, rows }));
        }
      },
    );

    const t = getTerminal();
    if (t && app.ptyBuffer.length > 0) {
      for (const chunk of app.ptyBuffer) {
        t.write(chunk);
      }
      app.ptyBuffer = [];
      app.hasSeenPtyOutput = true;
    }

    setTimeout(() => fitTerminal(), 0);
    setTimeout(() => focusTerminal(), 50);

    if (!app.hasSeenPtyOutput && !app.hasLoadedPtySnapshot) {
      app.hasLoadedPtySnapshot = true;
      fetch(`${PATH_PREFIX}/__layrr__/pty-buffer`)
        .then((r) => r.json())
        .then((data) => {
          const text = typeof data?.data === 'string' ? data.data : '';
          if (!text || app.hasSeenPtyOutput) return;
          const term = getTerminal();
          if (!term) {
            app.hasLoadedPtySnapshot = false;
            return;
          }
          term.write(text);
          app.hasSeenPtyOutput = true;
        })
        .catch(() => {
          app.hasLoadedPtySnapshot = false;
        });
    }
  }

  function showPanel(panel: HTMLElement) {
    const bar = document.getElementById(`${L}-bar`);
    if (!bar) return;

    const hp = document.getElementById(`${L}-history`);
    if (hp?.classList.contains('open')) {
      hp.classList.remove('open');
      hp.style.cssText = '';
    }
    bar.querySelector(`.${L}-bhi`)?.classList.remove('open');

    bar.classList.add('expanded');
    panel.classList.add('open');
    panel.style.cssText = '';
    syncEditSurface();
    if (isTerminalEditMode()) ensureTerminal();
    else focusPanelInput();
  }

  function showHistory(histPanel: HTMLElement, bar: HTMLElement) {
    const panel = app.panelEl;
    bar.querySelector(`.${L}-bhi`)?.classList.add('open');

    if (panel?.classList.contains('open')) {
      panel.classList.remove('open');
      panel.style.cssText = '';
    }

    bar.classList.add('expanded');
    histPanel.classList.add('open');
    histPanel.style.cssText = '';
  }

  function hidePanel(panel: HTMLElement) {
    const bar = document.getElementById(`${L}-bar`);
    if (!bar) return;
    const histOpen = document
      .getElementById(`${L}-history`)
      ?.classList.contains('open');
    if (histOpen) {
      panel.classList.remove('open');
      panel.style.cssText = '';
      return;
    }
    panel.classList.remove('open');
    panel.style.cssText = '';
    bar.classList.remove('expanded');
    bar.style.cssText = '';
  }

  function hideHistory(histPanel: HTMLElement) {
    const bar = document.getElementById(`${L}-bar`);
    if (!bar) return;
    const panelOpen = app.panelEl?.classList.contains('open');
    if (panelOpen) {
      histPanel.classList.remove('open');
      histPanel.style.cssText = '';
      return;
    }
    histPanel.classList.remove('open');
    histPanel.style.cssText = '';
    bar.classList.remove('expanded');
    bar.style.cssText = '';
  }

  // ---- Multi-select helpers ----
  function clearMultiHighlights() {
    app.multiHighlights.forEach((h) => h.remove());
    app.multiHighlights = [];
  }

  function updateMultiHighlights() {
    clearMultiHighlights();
    const root = document.querySelector(`.${L}-root`);
    if (!root) return;
    for (const el of app.selectedEls) {
      const mhl = document.createElement('div');
      mhl.className = `${L}-mhl`;
      const r = el.getBoundingClientRect();
      mhl.style.borderRadius = getComputedStyle(el).borderRadius || '2px';
      Object.assign(mhl.style, {
        left: `${r.left - 1}px`,
        top: `${r.top - 1}px`,
        width: `${r.width + 2}px`,
        height: `${r.height + 2}px`,
      });
      root.appendChild(mhl);
      app.multiHighlights.push(mhl);
    }
  }

  function clearSelection() {
    app.selectedEl = null;
    app.selectedEls = [];
    app.selectedSourceInfo = null;
    app.sourceInfoLoading = false;
    app.multiSourceInfoMap.clear();
    clearMultiHighlights();
    if (app.hlEl) {
      app.hlEl.style.display = 'none';
      app.hlEl.classList.remove('selected');
    }
    if (app.labelEl) app.labelEl.style.display = 'none';
    if (app.mode === 'edit' && app.panelEl) {
      updatePanelForSelection();
    } else if (app.panelEl) {
      hidePanel(app.panelEl);
    }
  }

  function escapeHtml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  let sourceInfoRequestId = 0;
  async function refreshSelectedSourceInfo(el: HTMLElement) {
    const reqId = ++sourceInfoRequestId;
    app.sourceInfoLoading = true;
    updatePanelForSelection();

    const sourceInfo = await extractSourceInfo(el);

    // Ignore stale results if selection changed.
    if (reqId !== sourceInfoRequestId) return null;
    if (app.selectedEls.length !== 1 || app.selectedEls[0] !== el) return null;

    app.selectedSourceInfo = sourceInfo;
    app.sourceInfoLoading = false;
    updatePanelForSelection();
    return sourceInfo;
  }

  function refreshMultiSourceInfo(el: HTMLElement) {
    if (app.multiSourceInfoMap.has(el)) return;
    extractSourceInfo(el).then((info) => {
      // Ignore if element was deselected while loading.
      if (!app.selectedEls.includes(el)) return;
      app.multiSourceInfoMap.set(el, info);
      if (app.selectedEls.length > 1) updatePanelForSelection();
    });
  }

  function updatePanelForSelection() {
    const panel = app.panelEl;
    if (!panel) return;
    const hn = panel.querySelector(`.${L}-hn`) as HTMLElement;
    const elInfo = panel.querySelector(`.${L}-ei`) as HTMLElement;

    if (!app.selectedEl && app.selectedEls.length === 0) {
      elInfo.innerHTML = `<div class="${L}-eh">Click to select an element or <kbd>Shift+click</kbd> to select multiple</div>`;
      if (hn) hn.style.display = 'none';
      elInfo.style.display = 'block';
      return;
    }

    if (hn) hn.style.display = '';

    if (app.selectedEls.length <= 1) {
      const el = app.selectedEls[0] || app.selectedEl;
      if (!el) return;
      const sourceMeta = getSourceInfoMeta(app.selectedSourceInfo);
      const sourceLine =
        app.selectedSourceInfo &&
        `${app.selectedSourceInfo.file}:${app.selectedSourceInfo.line}${app.selectedSourceInfo.column ? `:${app.selectedSourceInfo.column}` : ''}`;
      const chipClass = (hit: string) => {
        if (hit === '精确匹配') return 'exact';
        if (hit === '组件匹配') return 'component';
        if (hit === '文件匹配') return 'file-chip';
        return 'fallback';
      };
      const precisionWarn =
        !app.sourceInfoLoading &&
        sourceMeta.hit !== '精确匹配' &&
        sourceMeta.hit !== '服务端搜索'
          ? `<div class="${L}-precision-warn"><i class="icon-alert-triangle"></i>非精确匹配 — 编辑可能定位到错误代码，建议选择更具体的元素</div>`
          : '';
      elInfo.style.display = 'block';
      const statusRow = app.sourceInfoLoading
        ? `
            <div class="${L}-src-row">
              <span class="${L}-sk">来源</span>
              <span class="${L}-src-chip loading">加载中...</span>
            </div>
          `
        : `
            <div class="${L}-src-row">
              <span class="${L}-sk">来源</span>
              <span class="${L}-src-chip">${escapeHtml(sourceMeta.source)}</span>
            </div>
            <div class="${L}-src-row">
              <span class="${L}-sk">匹配</span>
              <span class="${L}-src-chip ${chipClass(sourceMeta.hit)}">${escapeHtml(sourceMeta.hit)}</span>
            </div>
          `;
      const pathRow =
        !app.sourceInfoLoading && sourceLine
          ? `
              <div class="${L}-src-row">
                <span class="${L}-sk">路径</span>
                <span class="${L}-src-path">${escapeHtml(sourceLine)}</span>
              </div>
            `
          : '';
      elInfo.innerHTML = `
          <div class="${L}-et">${escapeHtml(getTag(el))}</div>
          <div class="${L}-ex">${escapeHtml(el.textContent?.trim().slice(0, 50) || '(空)')}</div>
          <div class="${L}-ep">${escapeHtml(getBreadcrumb(el))}</div>
          ${statusRow}
          ${pathRow}
          ${precisionWarn}
        `;
    } else {
      const selectionContext = buildSelectionContext(app.selectedEls);
      let html = `<div class="${L}-et">Selected<span class="${L}-sel-count">${app.selectedEls.length}</span></div>`;
      html += `
        <div class="${L}-src-row">
          <span class="${L}-sk">Pattern</span>
          <span class="${L}-src-chip">${escapeHtml(selectionContext.selectionPattern)}</span>
        </div>
      `;
      if (selectionContext.commonBreadcrumb) {
        html += `
          <div class="${L}-src-row">
            <span class="${L}-sk">Scope</span>
            <span class="${L}-src-path">${escapeHtml(selectionContext.commonBreadcrumb)}</span>
          </div>
        `;
      }
      html += `<div class="${L}-ei-multi">`;
      const chipClass = (hit: string) => {
        if (hit === '精确匹配') return 'exact';
        if (hit === '组件匹配') return 'component';
        if (hit === '文件匹配') return 'file-chip';
        return 'fallback';
      };
      app.selectedEls.forEach((el, i) => {
        const tag = getTag(el).replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const summary = getElementSummary(el, 50) || '(empty)';
        const breadcrumb = getBreadcrumb(el);
        const cached = app.multiSourceInfoMap.get(el) ?? null;
        const hasInfo = app.multiSourceInfoMap.has(el);
        const hitLabel = hasInfo ? getSourceInfoMeta(cached).hit : '加载中...';
        const hitChipClass = hasInfo ? chipClass(hitLabel) : 'loading';
        html += `
          <div class="${L}-ei-item${app.selectedEl === el ? ` ${L}-ei-item-primary` : ''}">
            <button class="${L}-ei-rm" data-idx="${i}"><i class="icon-x"></i></button>
            <div class="${L}-ei-item-body">
              <div class="${L}-ei-item-title"><span class="${L}-ei-item-tag">${tag}</span>${app.selectedEl === el ? `<span class="${L}-ei-item-focus">focus</span>` : ''}<span class="${L}-src-chip ${hitChipClass}" style="flex-shrink:0">${escapeHtml(hitLabel)}</span></div>
              <div class="${L}-ei-item-sub">${escapeHtml(summary)}</div>
              <div class="${L}-ei-item-path">${escapeHtml(breadcrumb)}</div>
            </div>
          </div>
        `;
      });
      html += `</div>`;
      elInfo.style.display = 'block';
      elInfo.innerHTML = html;
      elInfo.querySelectorAll(`.${L}-ei-rm`).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const idx = parseInt((btn as HTMLElement).dataset.idx || '0');
          app.selectedEls.splice(idx, 1);
          if (app.selectedEls.length === 0) {
            clearSelection();
          } else {
            app.selectedEl = app.selectedEls[app.selectedEls.length - 1];
            updateMultiHighlights();
            updatePanelForSelection();
            if (app.selectedEls.length === 1)
              refreshSelectedSourceInfo(app.selectedEls[0]);
          }
        });
      });
    }
  }

  // ---- Polling ----
  function stopPolling() {
    if (app.pollTimer) {
      clearInterval(app.pollTimer);
      app.pollTimer = null;
    }
    if (app.spinnerTimeout) {
      clearTimeout(app.spinnerTimeout);
      app.spinnerTimeout = null;
    }
    setSendLoading(false);
  }

  function startPolling() {
    stopPolling();
    setSendLoading(true);
    app.pollTimer = setInterval(async () => {
      try {
        const resp = await fetch(`${PATH_PREFIX}/__layrr__/edit-status`);
        const data = await resp.json();
        if (data.success !== null && data.timestamp > app.lastEditTimestamp) {
          app.lastEditTimestamp = data.timestamp;
          stopPolling();
          onEditResult(data);
        }
      } catch {}
    }, 2000);
    app.spinnerTimeout = setTimeout(() => {
      stopPolling();
      toast('Edit timed out — no response received', 'error');
    }, 60000);
  }

  function onEditResult(msg: any) {
    stopPolling();
    if (msg.success) {
      app.editCount++;
      app.historyPage = 0;
      app.lastEdit = null;
      if (app.inputEl) app.inputEl.value = '';
      app.selectedEl = null;
      app.selectedEls = [];
      clearMultiHighlights();
      app.hoveredEl = null;
      if (app.hlEl) {
        app.hlEl.style.display = 'none';
        app.hlEl.classList.remove('selected');
      }
      if (app.labelEl) app.labelEl.style.display = 'none';
      if (app.panelEl) updatePanelForSelection();
      fetchAndRenderHistory();
      save();
      toast('Done!', 'success');
      focusPanelInput();
    } else {
      toast(msg.message || 'Edit failed', 'error');
    }
  }

  // ---- WebSocket ----
  function connectWs() {
    if (!isActiveInstance()) return;

    if (
      app.ws &&
      (app.ws.readyState === WebSocket.OPEN ||
        app.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = WS_PORT
      ? `${location.hostname}:${WS_PORT}`
      : location.hostname;
    const ws = new WebSocket(`${wsProto}//${wsHost}${PATH_PREFIX}/__layrr__/ws`);
    app.ws = ws;
    ws.onopen = () => {
      if (!isActiveInstance()) {
        ws.close();
        return;
      }
      app.connected = true;
      ws.send(JSON.stringify({ type: 'overlay-ready' }));
    };
    ws.onmessage = (ev) => {
      if (!isActiveInstance()) return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'layrr-config') {
          applyRuntimeConfig(msg);
        } else if (msg.type === 'pty-output') {
          const t = getTerminal();
          app.hasSeenPtyOutput = true;
          if (t) {
            t.write(msg.data);
          } else {
            app.ptyBuffer.push(msg.data);
          }
        } else if (msg.type === 'pty-error') {
          toast(msg.message || 'Terminal error', 'error');
        } else if (msg.type === 'edit-result') onEditResult(msg);
        else if (msg.type === 'history-updated') {
          app.historyPage = 0;
          fetchAndRenderHistory();
        } else if (msg.type === 'version-preview-result') {
          if (msg.success) {
            app.previewingHash = msg.hash;
            sessionStorage.setItem('__layrr_preview', msg.hash);
            toast(`Previewing: ${msg.message || msg.hash.slice(0, 7)}`, 'info');
            fetchAndRenderHistory();
            save();
            setTimeout(() => location.reload(), 1000);
          } else {
            toast('Preview failed', 'error');
          }
        } else if (msg.type === 'version-restore-result') {
          if (msg.success) {
            app.previewingHash = null;
            sessionStorage.removeItem('__layrr_preview');
            toast('Back to latest', 'success');
            fetchAndRenderHistory();
            save();
            setTimeout(() => location.reload(), 1000);
          } else {
            toast('Restore failed', 'error');
          }
        } else if (msg.type === 'version-revert-result') {
          if (msg.success) {
            app.previewingHash = null;
            sessionStorage.removeItem('__layrr_preview');
            toast('Permanently reverted', 'success');
            fetchAndRenderHistory();
            save();
            setTimeout(() => location.reload(), 1000);
          } else {
            toast('Revert failed', 'error');
          }
        } else if (msg.type === 'commit-result') {
          if (msg.success) {
            toast('Committed successfully', 'success');
            fetchAndRenderHistory();
          } else {
            toast(msg.message || 'Commit failed', 'error');
          }
        }
      } catch {}
    };
    ws.onerror = () => {
      if (!isActiveInstance()) return;
    };
    ws.onclose = () => {
      if (pageUnloading || !isActiveInstance()) return;
      const shouldReconnect = app.ws === ws;
      if (app.ws === ws) {
        app.connected = false;
        app.ws = null;
      }
      if (shouldReconnect) {
        setTimeout(() => {
          if (isActiveInstance()) connectWs();
        }, 2000);
      }
    };
  }

  layrrWindow.__LAYRR_CONNECT_WS__ = connectWs;

  // ---- Mode ----
  function setMode(m: 'browse' | 'edit') {
    const histOpen = document
      .getElementById(`${L}-history`)
      ?.classList.contains('open');
    if (m === app.mode && !histOpen) return;
    if (m === 'edit' && app.previewingHash) {
      toast('Go back to latest to make edits', 'info');
      return;
    }
    app.mode = m;
    const bar = app.barEl;
    const dim = app.dimEl;
    const panel = app.panelEl;
    if (!bar || !dim || !panel) return;
    const br = bar.querySelector(`.${L}-bbr`) as HTMLElement;
    const ed = bar.querySelector(`.${L}-bbe`) as HTMLElement;
    // Close history if open
    const hp = document.getElementById(`${L}-history`);
    const hi = bar.querySelector(`.${L}-bhi`) as HTMLElement;
    if (hp?.classList.contains('open')) {
      if (m === 'browse') {
        hideHistory(hp);
      }
      deactivateHistory(hi);
    }

    if (m === 'browse') {
      activateBrowse(br, ed);
      document.body.style.cursor = '';
      dim.classList.remove('active');
      dim.style.cssText = '';
      app.selectedEl = null;
      app.selectedEls = [];
      app.hoveredEl = null;
      clearMultiHighlights();
      if (app.hlEl) {
        app.hlEl.style.display = 'none';
        app.hlEl.classList.remove('selected');
      }
      if (app.labelEl) app.labelEl.style.display = 'none';
      // Only collapse edit panel if history isn't handling the collapse
      if (!hp?.classList.contains('open')) {
        hidePanel(panel);
      }
    } else {
      connectWs();
      activateEdit(br, ed);
      document.body.style.cursor = 'crosshair';
      dim.classList.add('active');
      dim.style.cssText = '';
      dimIn(dim);
      app.selectedEl = null;
      app.selectedEls = [];
      app.hoveredEl = null;
      clearMultiHighlights();
      if (app.hlEl) {
        app.hlEl.style.display = 'none';
        app.hlEl.classList.remove('selected');
      }
      if (app.labelEl) app.labelEl.style.display = 'none';
      updatePanelForSelection();
      showPanel(panel);
    }
    save();
  }

  // ---- Send edit ----
  function sendPanelEditRequest() {
    const instruction = app.inputEl?.value.trim() || '';
    if (!instruction) {
      toast('Enter an edit instruction first', 'info');
      app.inputEl?.focus();
      return;
    }
    if (app.selectedEls.length === 0 || !app.selectedEl) {
      toast('Select an element before sending an edit request', 'info');
      return;
    }
    if (app.ws?.readyState !== WebSocket.OPEN) {
      toast('Connection not ready yet. Try again in a moment.', 'error');
      return;
    }

    const primary = app.selectedEl;
    const elements = app.selectedEls.map((el, index) =>
      buildSelectedElementPayload(el, index, el === primary),
    );

    app.lastEdit = {
      tagName: primary.tagName.toLowerCase(),
      instruction,
    };

    const payload =
      elements.length > 1
        ? {
            type: 'edit-request' as const,
            selectionMode: 'multi' as const,
            selector: elements[0].selector,
            tagName: elements[0].tagName,
            className: elements[0].className,
            textContent: elements[0].textContent,
            instruction,
            primaryElement: elements.find((el) => el.isPrimary) || elements[0],
            elements,
            selectionContext: buildSelectionContext(app.selectedEls),
          }
        : {
            type: 'edit-request' as const,
            selectionMode: 'single' as const,
            selector: elements[0].selector,
            tagName: elements[0].tagName,
            className: elements[0].className,
            textContent: elements[0].textContent,
            instruction,
            sourceInfo: elements[0].sourceInfo,
          };

    app.ws.send(JSON.stringify(payload));
    startPolling();
  }

  // ---- Init: creates DOM, sets up bar-local listeners ----
  function showBarConfirm(
    bar: HTMLElement,
    msg: string,
    onConfirm: () => void,
  ) {
    if (bar.querySelector(`.${L}-confirm-overlay`)) return;
    const overlay = document.createElement('div');
    overlay.className = `${L}-confirm-overlay ${L}-bar-confirm`;
    overlay.innerHTML = `
      <div class="${L}-confirm-msg">${msg}</div>
      <div class="${L}-confirm-actions">
        <button class="${L}-confirm-cancel">Cancel</button>
        <button class="${L}-confirm-yes">Confirm</button>
      </div>
    `;
    const prevOverflow = bar.style.overflow;
    bar.style.overflow = 'visible';
    bar.appendChild(overlay);
    confirmIn(overlay);
    overlay
      .querySelector(`.${L}-confirm-cancel`)
      ?.addEventListener('click', () => {
        confirmOut(overlay).then(() => {
          overlay.remove();
          bar.style.overflow = prevOverflow;
        });
      });
    overlay
      .querySelector(`.${L}-confirm-yes`)
      ?.addEventListener('click', () => {
        onConfirm();
        confirmOut(overlay).then(() => {
          overlay.remove();
          bar.style.overflow = prevOverflow;
        });
      });
  }

  function init() {
    ensureStyles();
    const { dim, hl, label, panel, bar } = createElements();
    app.hlEl = hl;
    app.labelEl = label;
    app.modeTagEl = panel.querySelector(`.${L}-mode-tag`) as HTMLElement;
    app.panelEl = panel;
    app.barEl = bar;
    app.dimEl = dim;
    app.inputAreaEl = panel.querySelector(`.${L}-ia`) as HTMLElement;
    app.terminalContainer = document.getElementById(`${L}-terminal-container`);
    app.inputEl = panel.querySelector(`.${L}-in`) as HTMLTextAreaElement;
    app.sendBtnEl = panel.querySelector(`.${L}-sb`) as HTMLButtonElement;
    syncModeBadge();
    syncEditSurface();

    // Check for missed edit results
    fetch(`${PATH_PREFIX}/__layrr__/edit-status`)
      .then((r) => r.json())
      .then((data) => {
        if (data.success !== null && data.timestamp > app.lastEditTimestamp) {
          app.lastEditTimestamp = data.timestamp;
          onEditResult(data);
        }
      })
      .catch(() => {});

    // Bar-local listeners (safe to re-add — they're on elements that get recreated)
    const closeBtn = panel.querySelector(`.${L}-px`) as HTMLButtonElement;
    const browseBtn = bar.querySelector(`.${L}-bbr`) as HTMLElement;
    const editBtn = bar.querySelector(`.${L}-bbe`) as HTMLElement;
    const histBtn = bar.querySelector(`.${L}-bhi`) as HTMLElement;
    const histPanel = document.getElementById(`${L}-history`) as HTMLElement;
    const inputEl = app.inputEl;
    const sendBtn = app.sendBtnEl;

    for (const evt of [
      'mousedown',
      'pointerdown',
      'focusin',
      'keyup',
      'keypress',
    ] as const) {
      bar.addEventListener(
        evt,
        (e) => {
          if ((e.target as HTMLElement).closest('.xterm')) return;
          e.stopPropagation();
        },
        false,
      );
    }
    bar.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if ((e.target as HTMLElement).closest('.xterm')) return;
        if (e.key === 'Escape') {
          // Let Escape bubble up to document for global handling
          return;
        }
        e.stopPropagation();
      },
      false,
    );

    browseBtn.addEventListener('click', () => setMode('browse'));
    editBtn.addEventListener('click', () => setMode('edit'));
    closeBtn.addEventListener('click', () => {
      setMode('browse');
      app.hoveredEl = null;
    });
    sendBtn?.addEventListener('click', () => sendPanelEditRequest());
    inputEl?.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPanelEditRequest();
      }
    });

    // History toggle
    histBtn.addEventListener('click', () => {
      const wasOpen = histPanel.classList.contains('open');

      if (wasOpen) {
        // Close history
        hideHistory(histPanel);
        deactivateHistory(histBtn);
        activateBrowse(browseBtn, editBtn);
        app.mode = 'browse';
      } else {
        // Open history — clear edit state first
        connectWs();
        app.selectedEl = null;
        app.selectedEls = [];
        clearMultiHighlights();
        if (hl) {
          hl.style.display = 'none';
          hl.classList.remove('selected');
        }
        if (label) label.style.display = 'none';
        app.hoveredEl = null;
        document.body.style.cursor = '';
        dim.classList.remove('active');
        dim.style.cssText = '';
        app.mode = 'browse';
        activateHistory(browseBtn, editBtn, histBtn);
        showHistory(histPanel, bar);
        fetchAndRenderHistory();
      }
    });

    // Revert button
    const revertBtn = bar.querySelector(`.${L}-bgrv`) as HTMLElement;
    revertBtn.addEventListener('click', () => {
      connectWs();
      showBarConfirm(
        bar,
        'Revert to previous version?<br>All uncommitted AI edits will be lost.',
        () => revertToPrevious(),
      );
    });

    // Commit button
    const commitBtn = bar.querySelector(`.${L}-bgcm`) as HTMLElement;
    commitBtn.addEventListener('click', () => {
      connectWs();
      showBarConfirm(bar, 'Push to remote?', () => triggerCommit());
    });

    // Drag (uses local barDragging state, listeners on bar element)
    let barDragging = false,
      barOff = { x: 0, y: 0 };
    bar.addEventListener('mousedown', (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t) return;
      if (t.closest('.xterm')) return;

      // Expanded state drags from headers; collapsed state keeps an explicit left grip visible.
      const expanded = bar.classList.contains('expanded');
      const inEditHeader = !!t.closest(`.${L}-ph`);
      const inHistHeader = !!t.closest(`.${L}-hh`);
      const inCollapsedGrip = !!t.closest(`.${L}-bd`);
      if (expanded) {
        if (!inEditHeader && !inHistHeader) return;
      } else {
        if (!inCollapsedGrip) return;
      }

      // Never start drag when interacting with buttons/controls inside headers.
      if (t.closest('button')) return;

      barDragging = true;
      bar.classList.add('dragging');
      const r = bar.getBoundingClientRect();
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
      bar.style.left = `${r.left}px`;
      bar.style.top = `${r.top}px`;
      barOff = { x: e.clientX - r.left, y: e.clientY - r.top };
      e.preventDefault();
    });
    // Drag move/up need document listeners but we track via app to avoid stale refs
    (app as any)._barDragging = () => barDragging;
    (app as any)._barOff = () => barOff;
    (app as any)._setBarDragging = (v: boolean) => {
      barDragging = v;
    };

    // Restore saved state
    fetchAndRenderHistory();
    if (saved.barPos) {
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
      bar.style.left = saved.barPos.left;
      bar.style.top = saved.barPos.top;
    }
    if (saved.historyOpen) {
      // History takes priority over edit mode
      connectWs();
      app.mode = 'browse';
      histPanel.classList.add('open');
      histBtn.classList.add('open');
      bar.classList.add('expanded');
      browseBtn.classList.remove('active');
      editBtn.classList.remove('active');
      fetchAndRenderHistory();
    } else if (app.mode === 'edit') {
      app.mode = 'browse'; // Reset so setMode guard doesn't early-return
      setMode('edit');
    }
  }

  // ---- Document-level listeners: added ONCE in start() ----
  function setupGlobalListeners() {
    // Mousemove — hover highlight + drag
    document.addEventListener(
      'mousemove',
      (e: MouseEvent) => {
        const bar = app.barEl;
        const hl = app.hlEl;
        const label = app.labelEl;
        const barDragging = (app as any)._barDragging?.() || false;
        const barOff = (app as any)._barOff?.() || { x: 0, y: 0 };

        if (barDragging && bar) {
          bar.style.left = `${Math.max(4, Math.min(window.innerWidth - bar.offsetWidth - 4, e.clientX - barOff.x))}px`;
          bar.style.top = `${Math.max(4, Math.min(window.innerHeight - bar.offsetHeight - 4, e.clientY - barOff.y))}px`;
        }
        if (app.mode !== 'edit' || barDragging) return;
        if (app.selectedEl && !e.shiftKey) return;
        const t = e.target as HTMLElement;
        if (!hl || !label) return;
        if (isOwn(t)) {
          hl.style.display = 'none';
          label.style.display = 'none';
          return;
        }
        if (t !== app.hoveredEl) {
          app.hoveredEl = t;
          posHL(t, hl);
          posLabel(t, label);
        }
      },
      true,
    );

    // Mouseup — end drag
    document.addEventListener('mouseup', () => {
      const barDragging = (app as any)._barDragging?.() || false;
      if (barDragging) {
        (app as any)._setBarDragging?.(false);
        app.barEl?.classList.remove('dragging');
        save();
      }
    });

    // Click — element selection
    document.addEventListener(
      'click',
      (e) => {
        if (app.mode !== 'edit') return;
        const t = e.target as HTMLElement;
        if (isOwn(t)) return;
        e.preventDefault();
        e.stopPropagation();

        const hl = app.hlEl;
        const label = app.labelEl;
        const panel = app.panelEl;
        const terminalContainer = app.terminalContainer;
        if (!hl || !label || !panel || !terminalContainer) return;

        if (e.shiftKey && app.selectedEls.length > 0) {
          const idx = app.selectedEls.indexOf(t);
          if (idx >= 0) {
            app.selectedEls.splice(idx, 1);
            if (app.selectedEls.length === 0) {
              clearSelection();
              return;
            }
            app.selectedEl = app.selectedEls[app.selectedEls.length - 1];
          } else {
            app.selectedEls.push(t);
            app.selectedEl = t;
          }
          posHL(app.selectedEl, hl);
          hl.classList.add('selected');
          updateMultiHighlights();
          label.style.display = 'none';
          showPanel(panel);
          // Start fetching source info for all multi-selected elements.
          app.selectedEls.forEach((el) => refreshMultiSourceInfo(el));
          updatePanelForSelection();
        } else {
          app.selectedEl = t;
          app.selectedEls = [t];
          app.selectedSourceInfo = null;
          app.sourceInfoLoading = false;
          app.multiSourceInfoMap.clear();
          clearMultiHighlights();
          posHL(t, hl);
          hl.classList.add('selected');
          label.style.display = 'none';
          showPanel(panel);
          updatePanelForSelection();
        }

        const selected =
          app.selectedEls.length === 1 ? app.selectedEls[0] : null;
        const sourceInfoPromise = selected
          ? refreshSelectedSourceInfo(selected)
          : Promise.resolve(null);
        if (!selected) {
          app.selectedSourceInfo = null;
          app.sourceInfoLoading = false;
        }

        if (app.ws?.readyState === WebSocket.OPEN) {
          if (app.selectedEls.length === 1 && selected) {
            sourceInfoPromise.then((sourceInfo) => {
              if (
                app.selectedEls.length !== 1 ||
                app.selectedEls[0] !== selected
              )
                return;
              if (app.ws?.readyState !== WebSocket.OPEN) return;
              app.ws.send(
                JSON.stringify({
                  type: 'element-selected',
                  selector: getSelector(selected),
                  tagName: selected.tagName.toLowerCase(),
                  className: selected.className || '',
                  textContent: selected.textContent?.trim().slice(0, 100) || '',
                  sourceInfo,
                }),
              );
              if (isTerminalEditMode()) {
                setTimeout(() => focusTerminal(), 300);
              } else {
                focusPanelInput();
              }
            });
          } else if (app.selectedEls.length > 1) {
            const elements = app.selectedEls.map((el) => ({
              selector: getSelector(el),
              tagName: el.tagName.toLowerCase(),
              className: el.className || '',
              textContent: el.textContent?.trim().slice(0, 100) || '',
            }));
            app.ws.send(
              JSON.stringify({
                type: 'elements-selected',
                elements,
              }),
            );
            if (isTerminalEditMode()) {
              setTimeout(() => focusTerminal(), 300);
            } else {
              focusPanelInput();
            }
          }
        }
      },
      true,
    );

    // Keyboard shortcuts
    document.addEventListener(
      'keydown',
      (e) => {
        // Allow a "force exit" shortcut even when focus is inside the terminal.
        if (e.metaKey && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (app.mode === 'edit') setMode('browse');
          return;
        }
        if ((e.target as HTMLElement).closest('.xterm')) return;
        if ((e.metaKey || e.altKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          setMode(app.mode === 'browse' ? 'edit' : 'browse');
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          // Move focus to body to prevent browser from focusing toolbar buttons
          document.body.focus();
          const histPanel = document.getElementById(`${L}-history`);
          if (histPanel?.classList.contains('open')) {
            closeHistory();
          } else if (app.selectedEl) {
            clearSelection();
            app.hoveredEl = null;
          } else if (app.mode === 'edit') setMode('browse');
        }
      },
      true,
    );
  }

  // ---- Persistence across navigations ----
  function reinjectIfNeeded() {
    if (!document.querySelector(`.${L}-root`) && document.body) {
      init();
    }
  }

  function start() {
    init();
    setupGlobalListeners(); // Only once — references app.* for current DOM

    let reinjectTimer: ReturnType<typeof setTimeout> | null = null;
    new MutationObserver(() => {
      if (!document.querySelector(`.${L}-root`) && document.body) {
        if (reinjectTimer) clearTimeout(reinjectTimer);
        reinjectTimer = setTimeout(() => {
          reinjectTimer = null;
          reinjectIfNeeded();
        }, 50);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

    // Framework-specific navigation events
    document.addEventListener('astro:after-swap', reinjectIfNeeded);
    document.addEventListener('sveltekit:navigation-end', reinjectIfNeeded);
    window.addEventListener('popstate', () =>
      setTimeout(reinjectIfNeeded, 100),
    );
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start);
  else start();
})();
