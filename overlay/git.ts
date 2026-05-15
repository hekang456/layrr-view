import { app } from './state';
import { toast } from './elements';

const PATH_PREFIX = (window as any).__LAYRR_PATH_PREFIX__ || '';

function ensureLayrrWs() {
  const connect = (window as any).__LAYRR_CONNECT_WS__;
  if (typeof connect === 'function') connect();
}

export async function revertToPrevious() {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) {
    ensureLayrrWs();
    toast('Connecting...', 'info');
    return;
  }

  try {
    const resp = await fetch(`${PATH_PREFIX}/__layrr__/history`);
    const data: {
      head: string;
      commits: Array<{ hash: string; message: string; timeAgo: string; isPair: boolean }>;
    } = await resp.json();

    if (data.commits.length < 2) {
      toast('No previous version to revert to', 'info');
      return;
    }

    const previousHash = data.commits[1].hash;
    app.ws.send(JSON.stringify({ type: 'version-revert', hash: previousHash }));
    toast('Reverting to previous version...', 'info');
  } catch {
    toast('Failed to load history', 'error');
  }
}

export async function triggerCommit() {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) {
    ensureLayrrWs();
    toast('Connecting...', 'info');
    return;
  }

  app.ws.send(JSON.stringify({ type: 'commit-request' }));
  toast('Commit triggered...', 'info');
}
