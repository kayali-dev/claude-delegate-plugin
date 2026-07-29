function safeValue(value) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return { length: value.length };
  if (typeof value !== 'object') return String(value);
  const result = {};
  for (const key of ['status', 'phase', 'state', 'kind', 'requestId', 'attempt', 'error', 'errorCode']) {
    if (value[key] != null && ['string', 'number', 'boolean'].includes(typeof value[key])) result[key] = value[key];
  }
  if (value.pendingInput) {
    result.pendingInput = {
      kind: value.pendingInput.kind || null,
      requestId: value.pendingInput.requestId || null,
      timedOut: value.pendingInput.timedOut === true
    };
  }
  if (value.planPass) result.planPass = { state: value.planPass.state || null };
  if (value.planning) result.planning = { state: value.planning.state || null };
  if (value.remote?.connection) {
    result.connection = {
      status: value.remote.connection.status || null,
      attempt: value.remote.connection.attempt || 0
    };
  }
  if (Array.isArray(value.jobs)) result.jobs = { count: value.jobs.length };
  if (Object.keys(result).length) return result;
  return { keys: Object.keys(value).sort().slice(0, 12) };
}

export function observedState(value) {
  try { return JSON.stringify(safeValue(value)); }
  catch { return String(value); }
}

export async function waitForCondition(options) {
  const {
    description,
    observe,
    predicate = Boolean,
    timeoutMs = 5_000,
    intervalMs = 20,
    summarize = observedState
  } = options;
  if (!description) throw new Error('waitForCondition requires a description');
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    let observationFailed = false;
    try {
      last = await observe();
    } catch (error) {
      last = { error: error?.message || String(error) };
      observationFailed = true;
    }
    if (!observationFailed && predicate(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${description}; last saw ${summarize(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  }
}

export function waitForEventState(options) {
  const {
    source,
    description,
    predicate,
    timeoutMs = 4_000,
    summarize = observedState
  } = options;
  if (!description) throw new Error('waitForEventState requires a description');
  let last = source.getState();
  if (predicate(last)) return Promise.resolve(last);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      source.off('change', changed);
      reject(new Error(`timed out waiting for ${description}; last saw ${summarize(last)}`));
    }, timeoutMs);
    const changed = (state) => {
      last = state;
      if (!predicate(state)) return;
      clearTimeout(timeout);
      source.off('change', changed);
      resolve(state);
    };
    source.on('change', changed);
  });
}

export function waitForChildExit(options) {
  const {
    child,
    description,
    timeoutMs = 30_000
  } = options;
  if (!description) throw new Error('waitForChildExit requires a description');
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ status: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('exit', exited);
      child.off('error', failed);
    };
    const exited = (status, signal) => {
      cleanup();
      resolve({ status, signal });
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      const last = `pid=${child.pid ?? 'unknown'}, exitCode=${child.exitCode ?? 'null'}, signalCode=${child.signalCode ?? 'null'}, killed=${child.killed === true}`;
      child.kill('SIGTERM');
      reject(new Error(`timed out waiting for ${description}; last saw ${last}`));
    }, timeoutMs);
    child.once('exit', exited);
    child.once('error', failed);
  });
}
