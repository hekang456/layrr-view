// ============================================================================
// 1. Types & Initialization
// ============================================================================

export type SourceStrategy =
  | 'locatorjs'
  | 'inspector'
  | 'element-source'
  | 'react-debug'
  | 'vue-debug';

export type SourcePrecision = 'element' | 'component' | 'file';

export type SourceInfo = {
  file: string;
  line: number;
  column?: number;
  tagName?: string;
  strategy?: SourceStrategy;
  precision?: SourcePrecision;
};

type LocatorExpressionInfo = {
  loc?: {
    start?: {
      line?: number;
      column?: number;
    };
  };
};

type LocatorFileStorage = {
  filePath?: string;
  projectPath?: string;
  expressions?: LocatorExpressionInfo[];
};

// Source mapping via element-source
let _resolveSource:
  | ((node: object) => Promise<{
      filePath: string;
      lineNumber: number | null;
      columnNumber: number | null;
      componentName: string | null;
    } | null>)
  | null = null;

export async function initSourceMapping() {
  try {
    const es = await import('element-source');
    const resolver = es.createSourceResolver({
      resolvers: [
        es.vueResolver,
        es.svelteResolver,
        es.solidResolver,
        es.preactResolver,
      ],
    });
    _resolveSource = resolver.resolveSource;
  } catch {}
}

// ============================================================================
// 2. Main Entry point
// ============================================================================

export async function extractSourceInfo(
  el: HTMLElement,
): Promise<SourceInfo | null> {
  // Level 1: High Precision (Build-time attributes)
  const locatorSource = extractLocatorJsSourceInfo(el);
  console.log('[layrr] locatorSource result:', locatorSource);
  if (locatorSource) {
    return locatorSource;
  }

  // Level 2: Medium Precision (Runtime state extraction fallback)
  console.log('[layrr] falling through to legacy extraction');
  return extractLegacySourceInfo(el);
}

export function getSourceInfoMeta(sourceInfo: SourceInfo | null): {
  source: string;
  hit: string;
} {
  if (!sourceInfo) {
    return { source: '启发式推断', hit: '服务端搜索' };
  }

  const hitMap: Record<string, string> = {
    element: '精确匹配',
    component: '组件匹配',
    file: '文件匹配',
  };
  const sourceMap: Record<string, string> = {
    locatorjs: 'LocatorJS',
    inspector: 'Inspector',
    'element-source': 'Element-Source',
    'react-debug': 'React Fiber',
    'vue-debug': 'Vue Runtime',
    'source-info': '源码信息',
  };
  return {
    source: sourceMap[sourceInfo.strategy || 'source-info'] || sourceInfo.strategy || '源码信息',
    hit: sourceInfo.precision
      ? hitMap[sourceInfo.precision] || '模糊匹配'
      : '模糊匹配',
  };
}

// ============================================================================
// 3. Level 1: High Precision - Build-time Injected Attributes
// ============================================================================

function parseLocatorPath(dataPath: string): SourceInfo | null {
  const lastColon = dataPath.lastIndexOf(':');
  if (lastColon === -1) return null;
  const secondLastColon = dataPath.lastIndexOf(':', lastColon - 1);
  if (secondLastColon === -1) return null;

  const file = dataPath.slice(0, secondLastColon);
  const line = Number.parseInt(
    dataPath.slice(secondLastColon + 1, lastColon),
    10,
  );
  const column = Number.parseInt(dataPath.slice(lastColon + 1), 10);

  if (!file || Number.isNaN(line) || Number.isNaN(column)) return null;
  return { file, line, column, strategy: 'locatorjs', precision: 'element' };
}

function parseInspectorPath(dataPath: string): SourceInfo | null {
  const lastColon = dataPath.lastIndexOf(':');
  if (lastColon === -1) return null;
  const secondLastColon = dataPath.lastIndexOf(':', lastColon - 1);
  if (secondLastColon === -1) return null;

  const file = dataPath.slice(0, secondLastColon);
  const line = Number.parseInt(
    dataPath.slice(secondLastColon + 1, lastColon),
    10,
  );
  const column = Number.parseInt(dataPath.slice(lastColon + 1), 10);

  if (!file || Number.isNaN(line)) return null;
  return {
    file,
    line,
    column: Number.isNaN(column) ? undefined : column,
    strategy: 'inspector',
    precision: 'element',
  };
}

function resolveLocatorId(
  dataId: string,
  store: Record<string, LocatorFileStorage> | undefined,
): SourceInfo | null {
  const sep = dataId.lastIndexOf('::');
  if (sep === -1) return null;

  const fileFullPath = dataId.slice(0, sep);
  const expId = Number.parseInt(dataId.slice(sep + 2), 10);
  if (!fileFullPath || Number.isNaN(expId)) return null;

  const fileData = store?.[fileFullPath];
  const exp = fileData?.expressions?.[expId];
  const line = exp?.loc?.start?.line;
  const column = exp?.loc?.start?.column;
  if (!line || column == null) return null;

  const filePath = fileData?.filePath ?? fileFullPath;
  const projectPath = fileData?.projectPath ?? '';
  const file =
    fileData?.filePath && fileData?.projectPath
      ? `${projectPath}${filePath}`
      : filePath;

  return { file, line, column: column + 1, strategy: 'locatorjs', precision: 'element' };
}

function extractLocatorJsSourceInfo(el: HTMLElement): SourceInfo | null {
  // 1. LocatorJS
  const locatorTarget = el.closest(
    '[data-locatorjs], [data-locatorjs-id]',
  ) as HTMLElement | null;
  console.log(
    '[layrr] LocatorJS target found:',
    !!locatorTarget,
    locatorTarget
      ? {
          'data-locatorjs': locatorTarget.dataset.locatorjs,
          'data-locatorjs-id': locatorTarget.dataset.locatorjsId,
        }
      : null,
  );
  if (locatorTarget) {
    if (locatorTarget.dataset.locatorjs) {
      return parseLocatorPath(locatorTarget.dataset.locatorjs);
    }
    if (locatorTarget.dataset.locatorjsId) {
      return resolveLocatorId(
        locatorTarget.dataset.locatorjsId,
        (window as any).__LOCATOR_DATA__ as
          | Record<string, LocatorFileStorage>
          | undefined,
      );
    }
  }

  // 2. React Inspector (vite-plugin-react-inspector & code-inspector-plugin)
  const reactInspectorTarget = el.closest(
    '[data-inspector-line], [data-react-inspector], [data-insp-path]',
  ) as HTMLElement | null;
  console.log(
    '[layrr] React Inspector target found:',
    !!reactInspectorTarget,
    reactInspectorTarget
      ? {
          reactInspector: reactInspectorTarget.dataset.reactInspector,
          path: reactInspectorTarget.dataset.inspectorPath,
          relativePath: reactInspectorTarget.dataset.inspectorRelativePath,
          line: reactInspectorTarget.dataset.inspectorLine,
          column: reactInspectorTarget.dataset.inspectorColumn,
          inspPath: reactInspectorTarget.dataset.inspPath,
        }
      : null,
  );
  if (reactInspectorTarget) {
    if (reactInspectorTarget.dataset.inspPath) {
      // e.g. "src/pages/Dashboard/Dashboard.jsx:72:13:div"
      const parts = reactInspectorTarget.dataset.inspPath.split(':');
      if (parts.length >= 3) {
        const file = parts[0];
        const line = parseInt(parts[1], 10);
        const column = parseInt(parts[2], 10);
        const tagName = parts[3];
        if (file && !isNaN(line)) {
          return {
            file,
            line,
            column: isNaN(column) ? undefined : column,
            tagName: tagName || undefined,
            strategy: 'inspector',
            precision: 'element',
          };
        }
      }
    }

    if (reactInspectorTarget.dataset.reactInspector) {
      return parseInspectorPath(reactInspectorTarget.dataset.reactInspector);
    }
    const file =
      reactInspectorTarget.dataset.inspectorRelativePath ||
      reactInspectorTarget.dataset.inspectorPath;
    const line = parseInt(reactInspectorTarget.dataset.inspectorLine || '', 10);
    const column = parseInt(
      reactInspectorTarget.dataset.inspectorColumn || '',
      10,
    );
    if (file && !isNaN(line)) {
      return {
        file,
        line,
        column: isNaN(column) ? undefined : column,
        strategy: 'inspector',
        precision: 'element',
      };
    }
  }

  // 3. Vue Inspector (vite-plugin-vue-inspector)
  const vueInspectorTarget = el.closest(
    '[data-v-inspector]',
  ) as HTMLElement | null;
  if (vueInspectorTarget && vueInspectorTarget.dataset.vInspector) {
    return parseInspectorPath(vueInspectorTarget.dataset.vInspector);
  }

  return null;
}

// ============================================================================
// 4. Level 2: Medium Precision - Runtime Framework State (Fiber/VNode)
// ============================================================================

async function extractLegacySourceInfo(
  el: HTMLElement,
): Promise<SourceInfo | null> {
  if (_resolveSource) {
    try {
      const info = await _resolveSource(el);
      if (info?.filePath && info.lineNumber) {
        return {
          file: info.filePath,
          line: info.lineNumber,
          column: info.columnNumber ?? undefined,
          strategy: 'element-source',
          precision: 'component',
        };
      }
    } catch {}
  }

  // Fallback: manual React fiber / Vue instance extraction
  const fk = Object.keys(el).find(
    (k) =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
  );
  if (fk) {
    let f = (el as any)[fk];
    while (f) {
      if (f._debugSource) {
        return {
          file: f._debugSource.fileName,
          line: f._debugSource.lineNumber,
          column: f._debugSource.columnNumber,
          strategy: 'react-debug',
          precision: 'component',
        };
      }
      f = f.return;
    }
  }

  const v = (el as any).__vueParentComponent;
  if (v?.type?.__file) {
    return { file: v.type.__file, line: 1, strategy: 'vue-debug', precision: 'file' };
  }

  return null;
}

// ============================================================================
// 5. Level 3: Low Precision - DOM Heuristics & Selectors
// ============================================================================

function cleanText(value: string | null | undefined, limit = 100): string {
  return value?.trim().replace(/\s+/g, ' ').slice(0, limit) || '';
}

export function getElementTextPreview(el: HTMLElement, limit = 100) {
  return cleanText(el.textContent, limit);
}

export function getAccessibleLabel(el: HTMLElement, limit = 100) {
  const ariaLabel = cleanText(el.getAttribute('aria-label'), limit);
  if (ariaLabel) return ariaLabel;

  const title = cleanText(el.getAttribute('title'), limit);
  if (title) return title;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const placeholder = cleanText(el.placeholder, limit);
    if (placeholder) return placeholder;
    const value = cleanText(el.value, limit);
    if (value) return value;
  }

  if (el instanceof HTMLImageElement) {
    const alt = cleanText(el.alt, limit);
    if (alt) return alt;
  }

  return '';
}

export function getCommonAncestor(elements: HTMLElement[]): HTMLElement | null {
  if (elements.length === 0) return null;
  if (elements.length === 1) return elements[0].parentElement;

  let ancestor: HTMLElement | null = elements[0];
  while (ancestor && ancestor !== document.body) {
    const current = ancestor;
    if (elements.every((el) => current === el || current.contains(el))) {
      return current;
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

export function getTag(el: HTMLElement) {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls =
    el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
  return `<${tag}${id}${cls}>`;
}

export function getBreadcrumb(el: HTMLElement) {
  const p: string[] = [];
  let c: HTMLElement | null = el;
  while (c && c !== document.body && p.length < 4) {
    p.unshift(c.tagName.toLowerCase() + (c.id ? `#${c.id}` : ''));
    c = c.parentElement;
  }
  return p.join(' › ');
}

export function getSelector(el: HTMLElement) {
  if (el.id) return `#${el.id}`;
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.body) {
    let sel = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    if (cur.className && typeof cur.className === 'string') {
      const c = cur.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (c) sel += `.${c}`;
    }
    const p = cur.parentElement;
    if (p) {
      const sibs = Array.from(p.children).filter(
        (c) => c.tagName === cur!.tagName,
      );
      if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
    }
    parts.unshift(sel);
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

// ============================================================================
// 6. UI Overlay Utilities (Positioning, non-extraction)
// ============================================================================

export function posHL(el: HTMLElement, hl: HTMLElement) {
  const r = el.getBoundingClientRect();
  hl.style.borderRadius = getComputedStyle(el).borderRadius || '2px';
  Object.assign(hl.style, {
    left: `${r.left - 1}px`,
    top: `${r.top - 1}px`,
    width: `${r.width + 2}px`,
    height: `${r.height + 2}px`,
    display: 'block',
  });
}

export function posLabel(el: HTMLElement, lbl: HTMLElement) {
  const r = el.getBoundingClientRect();
  lbl.textContent = getTag(el);
  let top = r.top - 22;
  if (top < 4) top = r.bottom + 4;
  Object.assign(lbl.style, {
    left: `${r.left}px`,
    top: `${top}px`,
    display: 'block',
  });
}
