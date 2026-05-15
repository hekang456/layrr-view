import type { WebSocket } from 'ws';
import type { AgentName } from '../agents/base.js';
import type { PairUIMode } from '../ui-mode.js';
import { resolveSource } from '../editor/source-mapper.js';
import { editQueue } from './edit-queue.js';
import { preview, restore, revert, commit } from './version.js';
import {
  attachWs,
  handlePtyMessage,
  injectContext,
  initPty,
  type PtyMessage,
} from './pty.js';
import {
  writeContextFile,
  writeMissingContextFile,
  writeMultiContextFile,
  writePendingContextFile,
} from './context.js';

interface SourceInfo {
  file: string;
  line: number;
  column?: number;
  strategy?: string;
  precision?: 'element' | 'component' | 'file';
}

interface ElementInfo {
  selector: string;
  tagName: string;
  className: string;
  textContent: string;
  sourceInfo?: SourceInfo;
  breadcrumb?: string;
  tagLabel?: string;
  selectionIndex?: number;
  isPrimary?: boolean;
  accessibleLabel?: string;
}

interface ElementSelectedMsg extends ElementInfo {
  type: 'element-selected';
}

interface ElementsSelectedMsg {
  type: 'elements-selected';
  elements: ElementInfo[];
}

interface SelectionContextInfo {
  count: number;
  orderedBy: 'selection';
  commonAncestorSelector?: string;
  commonAncestorTag?: string;
  commonBreadcrumb?: string;
  selectionPattern: 'same-container' | 'same-tag' | 'mixed';
}

interface EditRequestMsg {
  type: 'edit-request';
  selectionMode?: 'single' | 'multi';
  selector: string;
  tagName: string;
  className: string;
  textContent: string;
  instruction: string;
  sourceInfo?: SourceInfo;
  primaryElement?: ElementInfo;
  elements?: ElementInfo[];
  selectionContext?: SelectionContextInfo;
}

let activeWs: WebSocket | null = null;

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {}
}

editQueue.setWsNotifier((success, message) => {
  if (!activeWs) return;
  sendJson(activeWs, {
    type: 'edit-result',
    success,
    message: message || (success ? 'Edit applied!' : 'Edit failed'),
  });
});

async function resolveElementInfo(el: ElementInfo, projectRoot: string) {
  return {
    tagName: el.tagName,
    className: el.className,
    textContent: el.textContent,
    selector: el.selector,
    breadcrumb: el.breadcrumb,
    tagLabel: el.tagLabel,
    selectionIndex: el.selectionIndex,
    isPrimary: el.isPrimary,
    accessibleLabel: el.accessibleLabel,
    sourceLocation: await resolveSource({
      tagName: el.tagName,
      className: el.className,
      textContent: el.textContent,
      sourceInfo: el.sourceInfo,
      projectRoot,
    }),
  };
}

async function handleEditRequest(editMsg: EditRequestMsg, projectRoot: string) {
  // ---- 打印前端采集信息 ----
  console.log('\n  ┌─────────────────────────────────────────');
  console.log('  │ [DEBUG] 前端采集信息');
  console.log('  │ selectionMode:', editMsg.selectionMode || 'single');
  console.log('  │ instruction:', editMsg.instruction);
  if (editMsg.elements && editMsg.elements.length > 1) {
    console.log(`  │ elements (${editMsg.elements.length}):`);
    for (const el of editMsg.elements) {
      console.log(`  │   - <${el.tagName}> text="${el.textContent}"`);
      if (el.sourceInfo) {
        console.log(
          `  │     sourceInfo: ${el.sourceInfo.file}:${el.sourceInfo.line} (strategy=${el.sourceInfo.strategy}, precision=${el.sourceInfo.precision})`,
        );
      } else {
        console.log('  │     sourceInfo: (none)');
      }
    }
    if (editMsg.selectionContext) {
      console.log(
        '  │ selectionPattern:',
        editMsg.selectionContext.selectionPattern,
      );
    }
  } else {
    console.log(`  │ tagName: <${editMsg.tagName}>`);
    console.log(`  │ className: "${editMsg.className}"`);
    console.log(`  │ textContent: "${editMsg.textContent}"`);
    console.log(`  │ selector: ${editMsg.selector}`);
    if (editMsg.sourceInfo) {
      console.log(
        `  │ sourceInfo: ${editMsg.sourceInfo.file}:${editMsg.sourceInfo.line} (strategy=${editMsg.sourceInfo.strategy}, precision=${editMsg.sourceInfo.precision})`,
      );
    } else {
      console.log('  │ sourceInfo: (none)');
    }
  }
  console.log('  └─────────────────────────────────────────');

  if (editMsg.elements && editMsg.elements.length > 1) {
    const resolvedElements = await Promise.all(
      editMsg.elements.map((el) => resolveElementInfo(el, projectRoot)),
    );
    const primaryElement =
      (editMsg.primaryElement
        ? await resolveElementInfo(editMsg.primaryElement, projectRoot)
        : resolvedElements.find((el) => el.isPrimary)) || resolvedElements[0];

    // ---- 打印后端解析信息 ----
    console.log('\n  ┌─────────────────────────────────────────');
    console.log('  │ [DEBUG] 后端解析信息 (multi)');
    for (const el of resolvedElements) {
      const loc = el.sourceLocation;
      if (loc) {
        console.log(
          `  │   - <${el.tagName}> → ${loc.filePath}:${loc.line} (quality=${loc.sourceMatchQuality}, strategy=${loc.sourceStrategy || 'unknown'})`,
        );
        if (loc.sourceMatchQuality !== 'precise') {
          console.log(
            `  │     ⚠ 非精确定位，服务端最终判定位置: ${loc.filePath}:${loc.line}`,
          );
          if (loc.context) {
            console.log(
              `  │     context:\n${loc.context
                .split('\n')
                .map((l: string) => `  │       ${l}`)
                .join('\n')}`,
            );
          }
        }
      } else {
        console.log(`  │   - <${el.tagName}> → (未找到源码位置)`);
      }
    }
    console.log('  └─────────────────────────────────────────');

    editQueue.push({
      instruction: editMsg.instruction,
      selectionMode: 'multi',
      tagName: primaryElement.tagName,
      className: primaryElement.className,
      textContent: primaryElement.textContent,
      selector: primaryElement.selector,
      sourceLocation: primaryElement.sourceLocation,
      primaryElement,
      elements: resolvedElements,
      selectionContext: editMsg.selectionContext,
    });
  } else {
    const sourceLocation = await resolveSource({
      tagName: editMsg.tagName,
      className: editMsg.className,
      textContent: editMsg.textContent,
      sourceInfo: editMsg.sourceInfo,
      projectRoot,
    });

    // ---- 打印后端解析信息 ----
    console.log('\n  ┌─────────────────────────────────────────');
    console.log('  │ [DEBUG] 后端解析信息 (single)');
    if (sourceLocation) {
      console.log(
        `  │ filePath: ${sourceLocation.filePath}:${sourceLocation.line}`,
      );
      console.log(
        `  │ sourceMatchQuality: ${sourceLocation.sourceMatchQuality}`,
      );
      console.log(
        `  │ sourceStrategy: ${sourceLocation.sourceStrategy || 'unknown'}`,
      );
      if (sourceLocation.sourceMatchQuality !== 'precise') {
        console.log(
          `  │ ⚠ 非精确定位，服务端最终判定位置: ${sourceLocation.filePath}:${sourceLocation.line}`,
        );
        if (sourceLocation.context) {
          console.log(
            `  │ context:\n${sourceLocation.context
              .split('\n')
              .map((l: string) => `  │   ${l}`)
              .join('\n')}`,
          );
        }
      }
    } else {
      console.log('  │ (未找到源码位置)');
    }
    console.log('  └─────────────────────────────────────────');

    editQueue.push({
      instruction: editMsg.instruction,
      selectionMode: editMsg.selectionMode || 'single',
      tagName: editMsg.tagName,
      className: editMsg.className,
      textContent: editMsg.textContent,
      selector: editMsg.selector,
      sourceLocation,
    });
  }
}

function shouldInjectTerminalContext(
  agentName?: AgentName,
  uiMode: PairUIMode = 'terminal',
) {
  return uiMode === 'terminal';
}

async function handleElementSelected(
  msg: ElementSelectedMsg,
  projectRoot: string,
  agentName?: AgentName,
  uiMode: PairUIMode = 'terminal',
) {
  writePendingContextFile(msg, projectRoot);

  const sourceLocation = await resolveSource({
    tagName: msg.tagName,
    className: msg.className,
    textContent: msg.textContent,
    sourceInfo: msg.sourceInfo,
    projectRoot,
  });

  if (!activeWs || activeWs.readyState !== activeWs.OPEN) return;

  if (sourceLocation) {
    writeContextFile(msg, sourceLocation, projectRoot);
    if (shouldInjectTerminalContext(agentName, uiMode)) {
      injectContext(`@.layrr/context.md `);
    }
  } else {
    writeMissingContextFile(msg, projectRoot);
    if (shouldInjectTerminalContext(agentName, uiMode)) {
      injectContext(`[Not found: ${msg.tagName}] `);
    }
  }
}

async function handleElementsSelected(
  msg: ElementsSelectedMsg,
  projectRoot: string,
  agentName?: AgentName,
  uiMode: PairUIMode = 'terminal',
) {
  const { elements } = msg;

  if (!elements || elements.length === 0) return;

  writeMultiContextFile(
    elements,
    elements.map(() => null),
    projectRoot,
  );

  const sourceLocations = await Promise.all(
    elements.map((el) =>
      resolveSource({
        tagName: el.tagName,
        className: el.className,
        textContent: el.textContent,
        projectRoot,
      }),
    ),
  );

  writeMultiContextFile(elements, sourceLocations, projectRoot);

  if (sourceLocations.some((loc) => loc !== null)) {
    if (shouldInjectTerminalContext(agentName, uiMode)) {
      injectContext(`@.layrr/context.md `);
    }
  } else if (shouldInjectTerminalContext(agentName, uiMode)) {
    injectContext(`[Not found: ${elements.map((e) => e.tagName).join(', ')}] `);
  }
}

export function handleWsConnection(
  ws: WebSocket,
  projectRoot: string,
  agentName?: AgentName,
  uiMode: PairUIMode = 'terminal',
) {
  activeWs = ws;

  sendJson(ws, {
    type: 'layrr-config',
    uiMode,
    agentName: agentName || '',
  });

  if (uiMode === 'terminal') {
    // Keep the existing PTY session on first browser connect and on reconnects.
    // Killing it here interrupts the just-launched agent and causes zsh SIGHUP warnings.
    initPty(projectRoot, agentName);
    attachWs(ws);
  }

  ws.on('close', () => {
    if (activeWs === ws) activeWs = null;
  });

  ws.on('message', async (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'pty-input':
        case 'pty-resize':
          handlePtyMessage(msg as PtyMessage);
          break;
        case 'element-selected':
          await handleElementSelected(
            msg as ElementSelectedMsg,
            projectRoot,
            agentName,
            uiMode,
          );
          break;
        case 'elements-selected':
          await handleElementsSelected(
            msg as ElementsSelectedMsg,
            projectRoot,
            agentName,
            uiMode,
          );
          break;
        case 'edit-request':
          await handleEditRequest(msg as EditRequestMsg, projectRoot);
          break;
        case 'version-preview':
          preview(ws, msg.hash, projectRoot);
          break;
        case 'version-restore':
          restore(ws, projectRoot);
          break;
        case 'version-revert':
          revert(ws, msg.hash, projectRoot);
          break;
        case 'commit-request':
          commit(ws, projectRoot);
          break;
      }
    } catch (err) {
      console.error('[layrr] Error handling WS message:', err);
    }
  });
}
