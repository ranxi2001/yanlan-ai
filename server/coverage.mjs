import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function createCoverageWorker() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const venvPython = path.join(root, '.venv-coverage', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  let child = null, sequence = 0, buffer = '';
  const jobs = new Map();
  function stop() {
    const processToStop = child; child = null; buffer = '';
    processToStop?.kill();
    for (const job of [...jobs.values()]) job.finish(new Error('Local coverage unavailable'));
  }
  function start() {
    if (child) return;
    child = spawn(process.env.YANLAN_COVERAGE_PYTHON || (existsSync(venvPython) ? venvPython : 'python'),
      ['-u', path.join(root, 'server/coverage.py'), '--model', process.env.YANLAN_SENSEVOICE_DIR || path.join(root, 'artifacts/models/sensevoice')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const current = child;
    child.on('error', () => { if (child === current) stop(); });
    child.on('exit', () => { if (child === current) stop(); });
    child.stdin.on('error', () => { if (child === current) stop(); });
    child.stdout.on('data', data => {
      if (child !== current) return;
      buffer += data.toString('utf8');
      if (buffer.length > 128000) return stop();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const result = JSON.parse(line), job = jobs.get(result.id);
          if (job) job.finish(result.error ? new Error('Local coverage failed') : null, result);
        } catch { /* Native runtime startup messages are not protocol output. */ }
      }
    });
  }
  return {
    close: stop,
    scout(bytes, lengths, signal) {
      signal?.throwIfAborted();
      if (bytes.length < 2 || bytes.length > 960000 || bytes.length % 2
        || !Array.isArray(lengths) || !lengths.length || lengths.length > 3
        || lengths.some(n => !Number.isInteger(n) || n <= 0 || n > 320000)
        || lengths.reduce((a, b) => a + b, 0) * 2 !== bytes.length) return Promise.reject(new Error('Invalid audio window'));
      if (jobs.size >= 4) return Promise.reject(new Error('Local coverage busy'));
      start();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const abort = () => stop();
        const timer = setTimeout(stop, 120000);
        const finish = (error, value) => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort); jobs.delete(id);
          if (error) reject(error); else resolve({ model: value.model, parts: value.parts });
        };
        jobs.set(id, { finish }); signal?.addEventListener('abort', abort, { once: true });
        child.stdin.write(JSON.stringify({ id, pcm: bytes.toString('base64'), lengths }) + '\n');
      });
    },
  };
}
