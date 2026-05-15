import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  appendFileSync,
} from 'fs';
import { join, relative } from 'path';
import type { SourceLocation } from '../editor/source-mapper.js';

interface ElementSelectedMsg {
  tagName: string;
  className?: string;
  textContent?: string;
  selector?: string;
  sourceInfo?: any;
}

function ensureLayrrDir(projectRoot: string) {
  const layrrDir = join(projectRoot, '.layrr');
  if (!existsSync(layrrDir)) mkdirSync(layrrDir, { recursive: true });
  return layrrDir;
}

function finalizeContextWrite(projectRoot: string, content: string) {
  const layrrDir = ensureLayrrDir(projectRoot);
  writeFileSync(join(layrrDir, 'context.md'), content, 'utf-8');
  injectClaudeMd(projectRoot);
  ensureGitignore(projectRoot);
}

function appendSelectedElementDetails(content: string, msg: ElementSelectedMsg) {
  let next = content;
  next += `- Tag: \`<${msg.tagName}>\`\n`;
  if (msg.className) next += `- Class: \`${msg.className}\`\n`;
  if (msg.textContent) next += `- Text: "${msg.textContent}"\n`;
  if (msg.selector) next += `- Selector: \`${msg.selector}\`\n`;
  return next;
}

export function writePendingContextFile(
  msg: ElementSelectedMsg,
  projectRoot: string,
): void {
  let content = `# Layrr Context\n\n`;
  content += `## Selected Element\n`;
  content = appendSelectedElementDetails(content, msg);
  content += `\n## Source Location\n`;
  content += `- Resolving source location...\n`;
  content += `\n## Editing Rules\n`;
  content += `- Wait for the latest selected element context before applying edits.\n`;
  content += `- Modify ONLY the selected element. Do not touch siblings or unrelated components.\n`;
  content += `- Make the smallest possible change. Do not refactor or clean up unrelated code.\n`;
  content += `- Do NOT start, run, or launch the project or dev server.\n`;
  finalizeContextWrite(projectRoot, content);
}

export function writeMissingContextFile(
  msg: ElementSelectedMsg,
  projectRoot: string,
): void {
  let content = `# Layrr Context\n\n`;
  content += `## Selected Element\n`;
  content = appendSelectedElementDetails(content, msg);
  content += `\n## Source Location\n`;
  content += `- ⚠ Not found\n`;
  content += `- The last click could not be mapped to source code. Do not use any previous selection context for this request.\n`;
  content += `\n## Editing Rules\n`;
  content += `- Resolve the correct file/component before making changes.\n`;
  content += `- Modify ONLY the selected element. Do not touch siblings or unrelated components.\n`;
  content += `- Make the smallest possible change. Do not refactor or clean up unrelated code.\n`;
  content += `- Do NOT start, run, or launch the project or dev server.\n`;
  finalizeContextWrite(projectRoot, content);
}

export function writeContextFile(
  msg: ElementSelectedMsg,
  sourceLocation: SourceLocation,
  projectRoot: string,
): string {
  const relPath = relative(projectRoot, sourceLocation.filePath).replace(
    /\\/g,
    '/',
  );
  const shortRef = `${relPath}:${sourceLocation.line}${sourceLocation.column ? `:${sourceLocation.column}` : ''}`;

  let content = `# Layrr Context\n\n`;
  content += `## Selected Element\n`;
  content = appendSelectedElementDetails(content, msg);

  content += `\n## Source Location\n`;
  content += `- File: \`${sourceLocation.filePath}\`\n`;
  content += `- Line: ${sourceLocation.line}\n`;
  if (sourceLocation.column) content += `- Column: ${sourceLocation.column}\n`;
  content += `- Match quality: ${sourceLocation.sourceMatchQuality}\n`;
  if (sourceLocation.sourceStrategy)
    content += `- Strategy: ${sourceLocation.sourceStrategy}\n`;

  if (sourceLocation.context) {
    const ext = sourceLocation.filePath.split('.').pop() || '';
    content += `\n## Code Context\n`;
    content += `\`\`\`${ext}\n${sourceLocation.context}\n\`\`\`\n`;

    const textTrimmed = (msg.textContent || '').trim();
    if (textTrimmed && !sourceLocation.context.includes(textTrimmed)) {
      content += `\n> ⚠ The selected text "${textTrimmed}" does not appear as a literal in the code context. It is rendered dynamically. Trace the variable/prop to find the actual source.\n`;
    }
  }

  content += `\n## Editing Rules\n`;
  content += `- **CRITICAL**: If the selected text is NOT a literal string in the code context (e.g. it comes from a variable, prop, array, or config), you MUST read the file and find where that variable/prop is DEFINED before making changes. Do NOT guess or modify the wrong location. Use your file reading tools to locate the actual definition.\n`;
  content += `- **FIELD PRECISION**: When the selected text maps to a specific field in a data structure (e.g. a \`label\` key in an object), ONLY modify that field. Do NOT modify sibling fields in the same object unless the user explicitly asks for them.\n`;
  content += `- Modify ONLY the selected element. Do not touch siblings or unrelated components.\n`;
  content += `- Make the smallest possible change. Do not refactor or clean up unrelated code.\n`;
  content += `- Do NOT start, run, or launch the project or dev server.\n`;
  finalizeContextWrite(projectRoot, content);

  return shortRef;
}

function injectClaudeMd(projectRoot: string) {
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  const layrrMarker = '<!-- layrr-context -->';
  const layrrBlock = `${layrrMarker}\nRead .layrr/context.md for current edit context and rules.\n<!-- /layrr-context -->`;

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, 'utf-8');
    if (existing.includes(layrrMarker)) {
      const updated = existing.replace(
        new RegExp(`${layrrMarker}[\\s\\S]*?<!-- /layrr-context -->`, 'm'),
        layrrBlock,
      );
      writeFileSync(claudeMdPath, updated, 'utf-8');
    } else {
      appendFileSync(claudeMdPath, `\n\n${layrrBlock}\n`, 'utf-8');
    }
  } else {
    writeFileSync(claudeMdPath, `${layrrBlock}\n`, 'utf-8');
  }
}

function ensureGitignore(projectRoot: string) {
  const gitignorePath = join(projectRoot, '.gitignore');
  if (!existsSync(gitignorePath)) return;
  const gitignore = readFileSync(gitignorePath, 'utf-8');
  if (!gitignore.includes('.layrr')) {
    appendFileSync(gitignorePath, '\n.layrr/\n', 'utf-8');
  }
}

export function writeMultiContextFile(
  elements: Array<{
    selector: string;
    tagName: string;
    className: string;
    textContent: string;
    sourceInfo?: any;
  }>,
  sourceLocations: Array<SourceLocation | null>,
  projectRoot: string,
): string[] {
  const shortRefs: string[] = [];
  let content = `# Layrr Context\n\n`;
  content += `## Selected Elements (${elements.length})\n\n`;

  elements.forEach((el, idx) => {
    const loc = sourceLocations[idx];
    const relPath = loc
      ? relative(projectRoot, loc.filePath).replace(/\\/g, '/')
      : null;
    const shortRef = loc
      ? `${relPath}:${loc.line}${loc.column ? `:${loc.column}` : ''}`
      : null;
    if (shortRef) shortRefs.push(shortRef);

    content += `### Element ${idx + 1}: \`<${el.tagName}>\`\n`;
    if (el.className) content += `- Class: \`${el.className}\`\n`;
    if (el.textContent) content += `- Text: "${el.textContent}"\n`;
    if (el.selector) content += `- Selector: \`${el.selector}\`\n`;

    if (loc) {
      content += `\n#### Source Location\n`;
      content += `- File: \`${loc.filePath}\`\n`;
      content += `- Line: ${loc.line}\n`;
      if (loc.column) content += `- Column: ${loc.column}\n`;
      content += `- Match quality: ${loc.sourceMatchQuality}\n`;
      if (loc.sourceStrategy) content += `- Strategy: ${loc.sourceStrategy}\n`;

      if (loc.context) {
        const ext = loc.filePath.split('.').pop() || '';
        content += `\n#### Code Context\n`;
        content += `\`\`\`${ext}\n${loc.context}\n\`\`\`\n`;
      }
    } else {
      content += `\n#### Source Location\n`;
      content += `- ⚠ Not found\n`;
    }
    content += '\n';
  });

  content += `## Editing Rules\n`;
  content += `- **CRITICAL**: If the selected text is NOT a literal string in the code context (e.g. it comes from a variable, prop, array, or config), you MUST read the file and find where that variable/prop is DEFINED before making changes. Do NOT guess or modify the wrong location. Use your file reading tools to locate the actual definition.\n`;
  content += `- **FIELD PRECISION**: When the selected text maps to a specific field in a data structure (e.g. a \`label\` key in an object), ONLY modify that field. Do NOT modify sibling fields in the same object unless the user explicitly asks for them.\n`;
  content += `- Modify ONLY the selected elements. Do not touch siblings or unrelated components.\n`;
  content += `- Make the smallest possible change. Do not refactor or clean up unrelated code.\n`;
  content += `- Do NOT start, run, or launch the project or dev server.\n`;
  finalizeContextWrite(projectRoot, content);

  return shortRefs;
}
