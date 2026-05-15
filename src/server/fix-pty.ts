import os from 'os';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export function fixPtyPermissions() {
  if (os.platform() !== 'darwin') return;
  try {
    const nodePtyDir = path.dirname(require.resolve('node-pty/package.json'));
    const spawnHelperPaths = [
      path.join(nodePtyDir, 'prebuilds', 'darwin-x64', 'spawn-helper'),
      path.join(nodePtyDir, 'prebuilds', 'darwin-arm64', 'spawn-helper'),
    ];
    for (const helper of spawnHelperPaths) {
      if (fs.existsSync(helper)) {
        fs.chmodSync(helper, 0o755);
      }
    }
  } catch (e) {
    // ignore
  }
}
