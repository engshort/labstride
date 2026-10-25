import { openSync, closeSync, constants } from 'node:fs';
import { diagnosticEvent } from '../core/diagnostics.ts';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { protectedPath } from '../target-helper/filesystem.ts';

// The kernel releases flock on pipe closure/process death. No stale PID or
// timer ever authorizes deleting a lock or someone else's filesystem path.
export async function acquireServiceLock(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, 'service.lock');
  protectedPath(directory);
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let guard;
  try { guard = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '/proc/self/fd/3', process.execPath, '-e', "process.stdout.write('locked\\n');process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'ignore', fd], env: { PATH: '/usr/bin:/bin' } }); }
  finally { closeSync(fd); }
  const exited = new Promise<void>(resolve => guard.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { guard.stdin!.end(); reject(Error('service_lock_unavailable')); }, 5000);
    guard.once('error', () => { clearTimeout(timer); reject(Error('service_lock_unavailable')); });
    guard.once('exit', () => { clearTimeout(timer); reject(Error('service_lock_present')); });
    guard.stdout!.once('data', part => { clearTimeout(timer); part.toString() === 'locked\n' ? resolve() : reject(Error('service_lock_unavailable')); });
  });
  return async () => { guard.stdin!.end(); await exited; };
}
export async function serviceLoop(runtime: { tick(): Promise<void>; close(): Promise<void> }, signal: AbortSignal, interval = 1000) {
  try {
    while (!signal.aborted) {
      try { await runtime.tick(); }
      catch { process.stderr.write(JSON.stringify(diagnosticEvent('tick_failed', new Date().toISOString())) + '\n'); }
      await new Promise<void>(resolve => { const end = () => { clearTimeout(timer); signal.removeEventListener('abort', end); resolve(); };
        const timer = setTimeout(end, interval); signal.addEventListener('abort', end, { once: true }); if (signal.aborted) end(); });
    }
  } finally { await runtime.close(); }
}
