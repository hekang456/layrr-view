import type { PendingEditRequest } from '../server/edit-queue.js';

function formatValue(value: string | undefined, fallback = '(none)') {
  return value && value.trim() ? value : fallback;
}

function summarizeSourceFiles(request: PendingEditRequest) {
  const counts = new Map<string, number>();
  for (const el of request.elements || []) {
    const filePath = el.sourceLocation?.filePath;
    if (!filePath) continue;
    counts.set(filePath, (counts.get(filePath) || 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}

function contextLooksLikeSignature(
  context: string,
  textContent: string,
): boolean {
  const searchText = textContent.trim();
  // 如果 context 包含选中文本，说明已经定位到渲染区域
  if (searchText && context.includes(searchText)) return false;
  // 如果包含 JSX return 语句或自闭合标签，说明接近渲染区域
  if (/return\s*\(/.test(context) || context.includes('/>')) return false;
  // 检测是否全是 import/type/interface/props 签名区域
  const signatureKeywords = [
    'import ',
    'export const',
    'export function',
    'interface ',
    'type ',
    ': {',
    '?: ',
  ];
  const lines = context.split('\n').filter((l) => l.trim());
  const signatureLines = lines.filter((l) =>
    signatureKeywords.some((kw) => l.includes(kw)),
  );
  return signatureLines.length > lines.length * 0.5;
}

function looksLikeDataValue(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^\d+(\.\d+)?$/.test(t)) return true;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return true;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return true;
  if (t.length <= 5 && /^\d/.test(t)) return true;
  return false;
}

export function buildPrompt(request: PendingEditRequest): string {
  const {
    instruction,
    selectionContext,
    tagName,
    className,
    textContent,
    selector,
    sourceLocation,
    elements,
  } = request;

  let prompt: string;

  if (elements && elements.length > 1) {
    const sourceFiles = summarizeSourceFiles(request);
    prompt = `The user is visually editing their web app. They selected ${elements.length} UI elements and want the same change applied to all of them.`;

    if (selectionContext) {
      prompt += `

**Selection context:**
- Pattern: ${selectionContext.selectionPattern}`;
    }

    if (sourceFiles.length > 0) {
      prompt += `

**Likely implementation scope:**`;
      for (const [filePath, count] of sourceFiles.slice(0, 5)) {
        prompt += `
- ${filePath} (${count} selected element${count === 1 ? '' : 's'})`;
      }
    }

    prompt += `

**Selected elements:**`;

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const isPrecise = el.sourceLocation?.sourceMatchQuality === 'precise';
      prompt += `

Element ${i + 1}${el.isPrimary ? ' (PRIMARY)' : ''}:
- Selection order: ${el.selectionIndex != null ? el.selectionIndex + 1 : i + 1}
- Tag: ${formatValue(el.tagLabel, `<${el.tagName}>`)}
- Text: "${formatValue(el.textContent)}"`;

      if (el.accessibleLabel && el.accessibleLabel !== el.textContent) {
        prompt += `
- Accessible label: "${el.accessibleLabel}"`;
      }

      // 非精确定位时保留 selector 和 className 辅助定位
      if (!isPrecise) {
        prompt += `
- Class: "${el.className}"`;
        if (el.breadcrumb) {
          prompt += `
- Breadcrumb: ${el.breadcrumb}`;
        }
        prompt += `
- Selector: ${el.selector}`;
      }

      if (el.sourceLocation) {
        const isSignatureArea = contextLooksLikeSignature(
          el.sourceLocation.context,
          el.textContent,
        );
        prompt += `
- Source match quality: ${el.sourceLocation.sourceMatchQuality}
- Source strategy: ${el.sourceLocation.sourceStrategy || 'unknown'}
- File: ${el.sourceLocation.filePath}:${el.sourceLocation.line}
- Code context:
\`\`\`
${el.sourceLocation.context}
\`\`\``;
        if (isSignatureArea) {
          prompt += `
- ⚠ Context appears to be in component signature area. Read forward to find the rendered markup.`;
        }
        if (
          el.textContent.trim() &&
          !el.sourceLocation.context.includes(el.textContent.trim())
        ) {
          const isDataValue = looksLikeDataValue(el.textContent);
          if (isDataValue) {
            prompt += `
- ⚠ Text "${el.textContent}" is a runtime DATA VALUE — it will not appear as a literal in source code. Find the component usage site in this file and locate the data field producing this value.`;
          } else {
            prompt += `
- ⚠ Text "${el.textContent}" not found in context — trace the component usage and variable imports as described in the editing rules.`;
          }
        }
      }
    }

    prompt += `

**User instruction:** "${instruction}"
(Note: Read the instruction carefully to see if it applies to all selected elements uniformly, or if it assigns different tasks to different elements. Modify the code that corresponds to the selected elements, including their underlying data/props if they are dynamically rendered. Do not touch adjacent unselected elements).`;

    prompt += `
**Editing rules:**
- CRITICAL: Modify ONLY the selected elements. Do not touch siblings or unrelated components.
- When using edit_file, always provide the line parameter from the element info.
- When using read_file, provide offset = line - 5 to read near the target line.
- If context shows imports/signature instead of rendered markup, read forward to find JSX/HTML.
- If the selected text is not a literal string in the context, trace it: find the component usage site, then follow variable imports to the definition file.
- If edit_file fails with "Text not found", re-read the target region and copy old_text verbatim.
- Make the smallest possible change. Do not refactor or clean up unrelated code.
- Do NOT start, run, or launch the project or dev server (e.g. npm start, npm run dev, yarn start). The dev server is already running.
- After the edit, return a short success or failure result.`;
  } else {
    prompt = `The user is visually editing their web app. They selected a UI element and want to make a change.

**Selected element:**
- Tag: <${tagName}>
- Class: "${className}"
- Text: "${textContent}"
- Selector: ${selector}`;

    if (sourceLocation) {
      const isSignatureArea = contextLooksLikeSignature(
        sourceLocation.context,
        textContent,
      );
      prompt += `

**Source location found:**
- Source match quality: ${sourceLocation.sourceMatchQuality}
- Source strategy: ${sourceLocation.sourceStrategy || 'unknown'}
- File: ${sourceLocation.filePath}
- Line: ${sourceLocation.line}
- Code context:
\`\`\`
${sourceLocation.context}
\`\`\``;
      if (isSignatureArea) {
        prompt += `
- ⚠ The code context above appears to be in the component signature/imports area, not the rendered markup. You MUST read forward in this file (using read_file with a higher offset) to find where "${textContent}" is actually rendered in JSX/HTML before making any edit.`;
      }
      // 当选中文本在 context 中找不到时，说明是动态渲染的值
      if (
        textContent.trim() &&
        !sourceLocation.context.includes(textContent.trim())
      ) {
        const isDataValue = looksLikeDataValue(textContent);
        if (isDataValue) {
          prompt += `
- ⚠ The selected text "${textContent}" is a runtime DATA VALUE (e.g., a number, time, date, or ID). It will NEVER appear as a literal string in source code. Do NOT search for this text with grep.
  Instead, the context shows a component/template DEFINITION. To find where this value is rendered:
  1. Search this SAME FILE for where the component/template is USED/INVOKED (e.g., grep for the component name in this file).
  2. At the usage site, find the data field or variable that produces this value (e.g., \`item.some_field\`, \`data.some_field\`).
  3. Edit that data field according to the user's instruction. Do NOT read package.json or config files.`;
        } else {
          prompt += `
- ⚠ The selected text "${textContent}" does not appear as a literal string in the code context above. It is rendered dynamically. Follow this tracing strategy to locate the actual code to edit:
  1. If the context shows a COMPONENT/TEMPLATE DEFINITION, search this file for where it is USED/INVOKED. The text is likely passed as a prop/attribute at the usage site.
  2. If at the usage site the value is a VARIABLE (e.g., \`name={SOME_VAR}\`), find where that variable is IMPORTED from, then read that imported file to find the variable's definition containing the text.
  3. If the imported file re-exports (e.g., \`export * from './sub'\`), follow the re-export chain.
  Use \`bash\` with \`grep\` to search efficiently. Do NOT read package.json or config files.`;
        }
      }
    }

    prompt += `

**User instruction:** "${instruction}" (Note: Apply this instruction EXCLUSIVELY to the targeted element described above. Do not touch adjacent elements).

**Editing rules:**
- CRITICAL: Modify ONLY the selected element. Do not touch siblings or unrelated components.
- When using edit_file, always provide the line parameter from the element info.
- When using read_file, provide offset = line - 5 to read near the target line.
- If context shows imports/signature instead of rendered markup, read forward to find JSX/HTML.
- If the selected text is not a literal string in the context, trace it: find the component usage site, then follow variable imports to the definition file.
- If edit_file fails with "Text not found", re-read the target region and copy old_text verbatim.
- Make the smallest possible change. Do not refactor or clean up unrelated code.
- Do NOT start, run, or launch the project or dev server (e.g. npm start, npm run dev, yarn start). The dev server is already running.
- After the edit, return a short success or failure result.`;
  }

  return prompt;
}
