import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const media = /\.(insv|insp|lrv|mp4|mov|webm|jpg|jpeg|png|dng|wav|m4a|part|zip|7z)$/i;
const privateDirectories = new Set(['.local', '.insta360-sync', 'dcim', 'downloads', '.demo', '.test-data', '.playwright-mcp', '.ssh', '.aws', '.agents', '.codex', 'node_modules', 'coverage']);
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['GitHub credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['API credential', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],
  ['credential in URL', /https?:\/\/[^\s/:@]+:[^\s/@]+@/],
  ['literal credential', /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b["']?\s*[:=]\s*["'](?!YOUR_|EXAMPLE_|REPLACE_|<)[^"'\\\r\n]{8,}["']/i],
  ['personal Windows path', /\b[A-Z]:[\\/]+(?:Users|Documents and Settings)[\\/]+(?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b)|YOUR_[A-Z_]+|<)[^\\/\s"'<>]+[\\/]/i],
  ['personal home path', /\/(?:home|Users)\/(?!YOUR_[A-Z_]+|<)[a-z0-9._-]+\//i],
];

function git(root, args, { binary = false } = {}) {
  const result = spawnSync('git', ['-C', root, '-c', `safe.directory=${path.resolve(root).replaceAll('\\', '/')}`, '-c', 'core.excludesFile=', ...args], {
    encoding: binary ? undefined : 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Git inspection failed. Run this check in a Git checkout with Git installed.');
  return result.stdout;
}

export function privateFileReason(filename) {
  const parts = filename.replaceAll('\\', '/').toLowerCase().split('/');
  const name = parts.at(-1);
  if (parts.some(part => privateDirectories.has(part))) return 'private or generated directory';
  if (media.test(name)) return 'media or transfer artifact';
  if ((/^config.*\.json$/.test(name) && filename !== 'config.example.json') || /\.local\.json$/.test(name)) return 'local configuration';
  if (/^\.env(?:\.|$)/.test(name) || /\.(pem|key|p12|pfx|log|tmp)$/i.test(name) || /^id_(?:rsa|ed25519)/.test(name)) return 'credentials or local output';
  return null;
}

export function contentReasons(filename, buffer) {
  const reasons = [];
  if (buffer.length > 2 * 1024 * 1024) return ['large artifact needs review'];
  if (buffer.includes(0)) return ['binary artifact needs review'];
  const text = buffer.toString('utf8');
  for (const [name, pattern] of rules) if (pattern.test(text)) reasons.push(name);
  if (filename !== 'config.example.json' && filename.toLowerCase().endsWith('.json')) {
    try {
      const value = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (value && typeof value === 'object' && 'cameraUrl' in value && 'destination' in value) reasons.push('runtime configuration');
    } catch {} // Source files are checked for credential formats even if not JSON.
  }
  return reasons;
}

export async function checkPublic(root = projectRoot) {
  const files = [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
  const issues = [];
  const inspect = (filename, buffer, source) => {
    for (const rule of contentReasons(filename, buffer)) issues.push({ filename, source, rule });
  };
  for (const filename of files) {
    const reason = privateFileReason(filename);
    if (reason) { issues.push({ filename, source: 'Git file list', rule: reason }); continue; }
    let info;
    try { info = await fs.lstat(path.join(root, filename)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info?.isSymbolicLink()) issues.push({ filename, source: 'working copy', rule: 'symbolic link needs review' });
    else if (info?.isFile()) {
      if (info.size > 2 * 1024 * 1024) issues.push({ filename, source: 'working copy', rule: 'large artifact needs review' });
      else inspect(filename, await fs.readFile(path.join(root, filename)), 'working copy');
    }
  }
  // Inspect the index itself: a sensitive staged blob may have been overwritten
  // by a harmless working-copy edit, or deleted only from the working copy.
  const staged = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  const seen = new Set();
  for (const record of staged) {
    const [, mode, oid, filename] = /^(\d+) ([a-f0-9]+) \d+\t([\s\S]+)$/.exec(record) ?? [];
    if (!filename) throw new Error('Cannot parse the Git index.');
    if (privateFileReason(filename)) continue;
    if (mode === '120000' || mode === '160000') {
      issues.push({ filename, source: 'Git index', rule: 'link or submodule needs review' }); continue;
    }
    const key = filename + '\0' + oid;
    if (!seen.has(key)) { inspect(filename, git(root, ['cat-file', 'blob', oid], { binary: true }), 'Git index'); seen.add(key); }
  }
  return { files, issues };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkPublic().then(({ files, issues }) => {
    if (issues.length) {
      console.error('Public-file check failed (matching values are omitted):');
      for (const { filename, source, rule } of issues) console.error(`  ${filename} [${source}]: ${rule}`);
      process.exitCode = 1;
    } else console.log(`Public-file check passed: ${files.length} source files; working copy and staged content checked.`);
  }).catch(() => { console.error('Public-file check could not complete. Check Git availability and run it from this project checkout.'); process.exitCode = 1; });
}
