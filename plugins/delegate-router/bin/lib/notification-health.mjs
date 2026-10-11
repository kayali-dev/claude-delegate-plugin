import path from 'node:path';
import { NotificationHandoff } from './notification-handoff.mjs';
import { notificationMode } from './notification-settings.mjs';
import { controllerSession } from './admission.mjs';
import { dataDir, enabledProviders, listJobs } from './state.mjs';

export function notificationHealth(input = {}, options = {}) {
  const directory = options.stateDirectory || dataDir();
  const mode = notificationMode(directory);
  const sessionId = input.sessionId || process.env.CLAUDE_CODE_SESSION_ID || null;
  const projectDir = input.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const scope = input.scope || 'session';
  const ambientEnabled = String(process.env.DELEGATE_MONITOR ?? '1') !== '0' && scope !== 'off';
  const enabled = options.enabled || enabledProviders();
  const jobs = options.jobs || listJobs();
  const liveJobs = jobs.filter((job) => sessionId && controllerSession(job) === sessionId && (job.provider === 'claude' || enabled.includes(job.provider))
    && ['queued', 'running'].includes(job.status));
  let native = 'unavailable', leaseUntil = 0, nativeDisabled = false;
  if (sessionId && path.isAbsolute(projectDir)) {
    try {
      const record = new NotificationHandoff({ stateDirectory: directory, scope, sessionId, projectDir }).read();
      leaseUntil = record.leaseUntil || 0;
      nativeDisabled = record.nativeDisabled === true;
      native = nativeDisabled ? 'disabled' : leaseUntil > (options.now ?? Date.now()) ? 'healthy' : 'expired';
    } catch { native = 'unavailable'; }
  }
  return { mode, native, leaseUntil, ambientEnabled, liveJobCount: liveJobs.length,
    needsFallback: mode === 'native' && !nativeDisabled && ambientEnabled && native !== 'healthy' && liveJobs.length > 0,
    recoverySkill: 'delegate-router:monitor-fallback',
    persistentSkill: 'delegate-router:legacy-monitor',
    note: 'Delivery health only, not agent liveness. Invoke the recovery skill when needsFallback is true; never change an explicit opt-out. An idle session cannot recover a completely unloaded Mod without a running monitor.' };
}
