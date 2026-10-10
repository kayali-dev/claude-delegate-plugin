import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Non-Git fallback: fingerprints, never file bodies. Do not follow directory
// symlinks or inspect credentials/runtime state. This is detection, not isolation.
const SENSITIVE = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*(?:secret|credential|private.?key|token)[^/]*|[^/]+\.(?:pem|key|p12|pfx|crt|cer))$/i;
const OMIT = new Set(['.git', 'node_modules']);
export function sensitiveObservationPath(file) { return SENSITIVE.test(String(file).split(path.sep).join('/')); }

export function fileMetadata(cwd, file) {
  try {
    const stat = fs.lstatSync(path.join(cwd, file));
    return `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return null; }
}

export function observeDirectory(cwd, { exclude = [], maxEntries = 5000, maxBytes = 32 * 1024 * 1024, timeoutMs = 2000 } = {}) {
  const files = Object.create(null);
  const deadline = Date.now() + timeoutMs;
  const excluded = exclude.map((value) => path.resolve(value));
  let entries = 0; let bytes = 0; let complete = true;
  const visit = (directory) => {
    let handle;
    try {
      handle = fs.opendirSync(directory);
      for (let entry; (entry = handle.readSync()) != null;) {
        if (++entries > maxEntries || Date.now() >= deadline) { complete = false; break; }
        const absolute = path.join(directory, entry.name);
        if (OMIT.has(entry.name) || excluded.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`))) continue;
        const relative = path.relative(cwd, absolute).split(path.sep).join('/');
        const stat = fs.lstatSync(absolute);
        if (stat.isDirectory()) { if (SENSITIVE.test(relative)) continue; visit(absolute); if (!complete) break; continue; }
        if (!stat.isFile() && !stat.isSymbolicLink()) continue;
        const fingerprint = { size: stat.size, mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, hash: null };
        if (!SENSITIVE.test(relative) && stat.isSymbolicLink()) fingerprint.hash = crypto.createHash('sha256').update(fs.readlinkSync(absolute)).digest('hex');
        else if (!SENSITIVE.test(relative) && stat.isFile() && stat.size <= 1024 * 1024 && bytes + stat.size <= maxBytes) {
          bytes += stat.size;
          fingerprint.hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        }
        files[relative] = fingerprint;
      }
    } catch { complete = false; }
    finally { if (handle) { try { handle.closeSync(); } catch { complete = false; } } }
  };
  visit(path.resolve(cwd));
  return { files, complete };
}

export function compareDirectoryObservations(before, after) {
  return [...new Set([...Object.keys(before?.files || {}), ...Object.keys(after.files)])].sort().flatMap((file) => {
    const a = before?.files?.[file]; const b = after.files[file];
    if (a && b && a.mode === b.mode && (a.hash && b.hash ? a.hash === b.hash
      : a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs)) return [];
    // An absent entry in an incomplete snapshot is unknown, not an addition/deletion.
    if ((!a && before?.complete !== true) || (!b && after.complete !== true)) return [];
    return [{ path: file, status: !a ? '??' : !b ? ' D' : ' M', ...(a ? { preexisting: true } : {}), observation: 'filesystem' }];
  });
}
