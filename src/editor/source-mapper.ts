import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname, isAbsolute } from 'path';

interface ResolveRequest {
  tagName: string;
  className: string;
  textContent: string;
  sourceInfo?: {
    file: string;
    line: number;
    column?: number;
    tagName?: string;
    strategy?: string;
    precision?: 'element' | 'component' | 'file';
  };
  projectRoot: string;
}

export type SourceMatchQuality =
  | 'precise'
  | 'component'
  | 'fallback'
  | 'server search';

export interface SourceLocation {
  filePath: string;
  line: number;
  column?: number;
  tagName?: string;
  context: string;
  sourceMatchQuality: SourceMatchQuality;
  sourceStrategy?: string;
}

const SOURCE_EXTENSIONS = new Set([
  '.tsx',
  '.jsx',
  '.vue',
  '.svelte',
  '.html',
  '.astro',
  '.ts',
  '.js',
]);

// 尝试用"后缀匹配"把宿主机绝对路径映射到 projectRoot 下的真实文件
// 从最长后缀开始逐步剥离前缀，优先选更具体的匹配，至少保留 2 段避免误命中
function resolveByTailSegments(projectRoot, absFile) {
  const parts = absFile.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  // 优先至少保留 2 段后缀
  for (let i = 0; i <= parts.length - 2; i++) {
    const candidate = join(projectRoot, parts.slice(i).join('/'));
    if (existsSync(candidate)) return candidate;
  }
  // 最后兜底：单独文件名
  const tailOnly = join(projectRoot, parts[parts.length - 1]);
  if (existsSync(tailOnly)) return tailOnly;
  return null;
}

// Prioritize page/layout files over component library files
function sortByRelevance(files: string[]): string[] {
  return files.sort((a, b) => {
    const score = (f: string) => {
      if (f.includes('/pages/')) return 0;
      if (f.includes('/layouts/')) return 1;
      if (f.endsWith('.astro') || f.endsWith('.html')) return 2;
      if (f.endsWith('.vue') || f.endsWith('.svelte')) return 3;
      if (f.endsWith('.tsx') || f.endsWith('.jsx')) return 4;
      // Component library / ui files are least likely to be the direct target
      if (f.includes('/ui/') || f.includes('/components/ui/')) return 6;
      return 5;
    };
    return score(a) - score(b);
  });
}

function walkSourceFiles(dir: string, files: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir)) {
      if (
        entry.startsWith('.') ||
        entry === 'node_modules' ||
        entry === 'dist' ||
        entry === '.next' ||
        entry === '.astro'
      )
        continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walkSourceFiles(full, files);
      } else if (SOURCE_EXTENSIONS.has(extname(full))) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}

function getContext(lines: string[], lineIndex: number): string {
  const start = Math.max(0, lineIndex - 10);
  const end = Math.min(lines.length, lineIndex + 11);
  return lines.slice(start, end).join('\n');
}

function enhanceContext(
  lines: string[],
  initialLine: number,
  textContent: string,
  className?: string,
): { context: string; line: number } {
  const initialContext = getContext(lines, initialLine - 1);
  const searchText = textContent.trim();

  if (searchText && initialContext.includes(searchText)) {
    const start = Math.max(0, initialLine - 1 - 10);
    const end = Math.min(lines.length, initialLine - 1 + 11);
    for (let i = start; i < end; i++) {
      if (lines[i].includes(searchText)) {
        return { context: getContext(lines, i), line: i + 1 };
      }
    }
    return { context: initialContext, line: initialLine };
  }

  if (searchText) {
    const searchRadius = 30;
    for (let offset = 1; offset <= searchRadius; offset++) {
      const down = initialLine - 1 + offset;
      if (down < lines.length && lines[down].includes(searchText)) {
        return { context: getContext(lines, down), line: down + 1 };
      }
      const up = initialLine - 1 - offset;
      if (up >= 0 && lines[up].includes(searchText)) {
        return { context: getContext(lines, up), line: up + 1 };
      }
    }
  }

  if (className) {
    const classNames = className.split(/\s+/).filter(Boolean);
    if (classNames.length > 0) {
      const searchRadius = 30;
      for (let offset = 1; offset <= searchRadius; offset++) {
        const down = initialLine - 1 + offset;
        if (down < lines.length) {
          const matchCount = classNames.filter((cn) =>
            lines[down].includes(cn),
          ).length;
          if (matchCount >= Math.min(2, classNames.length)) {
            return { context: getContext(lines, down), line: down + 1 };
          }
        }
        const up = initialLine - 1 - offset;
        if (up >= 0) {
          const matchCount = classNames.filter((cn) =>
            lines[up].includes(cn),
          ).length;
          if (matchCount >= Math.min(2, classNames.length)) {
            return { context: getContext(lines, up), line: up + 1 };
          }
        }
      }
    }
  }

  return { context: initialContext, line: initialLine };
}

interface Match {
  filePath: string;
  line: number;
  context: string;
  score: number; // lower is better
}

function findElement(
  projectRoot: string,
  textContent: string,
  tagName: string,
  className: string,
): SourceLocation | null {
  let files = walkSourceFiles(join(projectRoot, 'src'));
  if (files.length === 0) {
    files = walkSourceFiles(projectRoot);
  }
  files = sortByRelevance(files);

  const candidates: Match[] = [];
  const searchText = textContent.trim();

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let score = 100;

        // Best: line contains the text AND the tag
        if (searchText && line.includes(searchText)) {
          score = 10;
          // Even better if it also has the tag
          if (line.includes(`<${tagName}`)) {
            score = 1;
          }
          // Bonus for class match
          if (
            className &&
            className.split(/\s+/).some((cn) => line.includes(cn))
          ) {
            score -= 2;
          }
          candidates.push({
            filePath,
            line: i + 1,
            context: getContext(lines, i),
            score,
          });
        }
        // Also check: tag + multiple class matches on same line (no text match)
        else if (line.includes(`<${tagName}`) && className) {
          const classNames = className.split(/\s+/).filter(Boolean);
          const matchCount = classNames.filter((cn) =>
            line.includes(cn),
          ).length;
          if (matchCount >= 2) {
            score = 20 + (classNames.length - matchCount);
            candidates.push({
              filePath,
              line: i + 1,
              context: getContext(lines, i),
              score,
            });
          }
        }
      }
    } catch {}
  }

  if (candidates.length === 0) return null;

  // Return the best match
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];
  return {
    filePath: best.filePath,
    line: best.line,
    context: best.context,
    tagName: tagName,
    sourceMatchQuality: 'server search',
    sourceStrategy: 'server-search',
  };
}

export async function resolveSource(
  req: ResolveRequest,
): Promise<SourceLocation | null> {
  if (req.sourceInfo?.file && req.sourceInfo?.line) {
    let filePath = req.sourceInfo.file;

    if (isAbsolute(filePath)) {
      // 绝对路径：存在就直接用；否则尝试后缀匹配到 projectRoot 下
      if (!existsSync(filePath)) {
        const mapped = resolveByTailSegments(req.projectRoot, filePath);
        if (mapped) {
          filePath = mapped;
        } else {
          // 映射不到就别走原来的盲目拼接，直接 fallback 到文本搜索
          return findElement(
            req.projectRoot,
            req.textContent,
            req.tagName,
            req.className,
          );
        }
      }
    } else {
      // 相对路径：保持原行为，拼到 projectRoot
      filePath = join(req.projectRoot, filePath.replace(/^\//, ''));
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const initialLine = req.sourceInfo.line;
      const { context, line } = enhanceContext(
        lines,
        initialLine,
        req.textContent,
        req.className,
      );
      const qualityMap: Record<string, SourceMatchQuality> = {
        element: 'precise',
        component: 'component',
        file: 'fallback',
      };
      return {
        filePath,
        line,
        column: line === initialLine ? req.sourceInfo.column : undefined,
        tagName: req.sourceInfo.tagName,
        context,
        sourceMatchQuality: req.sourceInfo.precision
          ? qualityMap[req.sourceInfo.precision] || 'fallback'
          : 'fallback',
        sourceStrategy: req.sourceInfo.strategy,
      };
    } catch (err) {
      console.warn(
        `[layrr] resolveSource: failed to read ${filePath} from sourceInfo, falling back to search:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return findElement(
    req.projectRoot,
    req.textContent,
    req.tagName,
    req.className,
  );
}
