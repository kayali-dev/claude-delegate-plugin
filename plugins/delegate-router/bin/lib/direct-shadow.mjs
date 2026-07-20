import {
  appendJobEvent,
  completeShadowJob,
  createShadowJob,
  inspectJob,
  isDirectTransport,
  updateManagedJob
} from './control.mjs';
import { loadJob } from './state.mjs';

export class DirectShadowJournal {
  constructor(job, options = {}) {
    this.job = job || null;
    this.id = job?.id || null;
    this.prefix = options.prefix || 'delegate-shadow';
    this.active = Boolean(job);
    this.warned = false;
    this.lastCompletedText = null;
  }

  warn(error) {
    if (this.warned) return;
    this.warned = true;
    const message = error?.message || String(error);
    console.error(`${this.prefix}: shadow journaling unavailable; direct call continues unjournaled: ${message}`);
  }

  safe(callback) {
    if (!this.active || !this.id) return null;
    try { return callback(this.job); }
    catch (error) {
      this.active = false;
      this.warn(error);
      return null;
    }
  }

  event(type, data = {}, options = {}) {
    return this.safe(() => appendJobEvent(this.id, type, data, options));
  }

  update(mutate, options = {}) {
    return this.safe(() => {
      const updated = updateManagedJob(this.id, mutate, { incrementRevision: false, ...options });
      this.job = updated;
      return updated;
    });
  }

  setSession(providerSessionId, resolvedModel = null) {
    if (!providerSessionId && !resolvedModel) return null;
    return this.update((job) => {
      if (providerSessionId) {
        job.providerSessionId = providerSessionId;
        job.session = providerSessionId;
      }
      if (resolvedModel) job.resolvedModel = resolvedModel;
    });
  }

  messageCompleted(text, options = {}) {
    if (typeof text !== 'string' || !text || text === this.lastCompletedText) return null;
    this.lastCompletedText = text;
    return this.event('message.completed', { text }, options);
  }

  usage(value, options = {}) {
    return this.safe(() => {
      appendJobEvent(this.id, 'usage.updated', value, options);
      this.job = updateManagedJob(this.id, (job) => { job.usage = value; }, { incrementRevision: false });
      return value;
    });
  }

  complete(outcome = {}) {
    return this.safe(() => {
      const completed = completeShadowJob(this.id, outcome);
      this.job = completed;
      this.active = false;
      return completed;
    });
  }

  inspect() {
    return this.safe(() => inspectJob(this.id));
  }
}

export function beginDirectShadow(options, journalOptions = {}) {
  try {
    return new DirectShadowJournal(createShadowJob(options), journalOptions);
  } catch (error) {
    const journal = new DirectShadowJournal(null, journalOptions);
    journal.warn(error);
    return journal;
  }
}

export function adoptDirectShadow(id, journalOptions = {}) {
  try {
    const job = id ? loadJob(id) : null;
    if (!job || !isDirectTransport(job)) return null;
    return new DirectShadowJournal(job, journalOptions);
  } catch (error) {
    const journal = new DirectShadowJournal(null, journalOptions);
    journal.warn(error);
    return journal;
  }
}
