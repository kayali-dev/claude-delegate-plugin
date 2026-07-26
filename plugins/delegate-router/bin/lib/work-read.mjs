import { brokerError } from './errors.mjs';
import { listJobs } from './state.mjs';
import { projectJobsAsWorkItems } from './work-projection.mjs';

export function readProjectedWorkItems(options = {}) {
  let workItems = projectJobsAsWorkItems(listJobs());
  if (options.id != null) {
    if (typeof options.id !== 'string' || !options.id) throw brokerError('INVALID_REQUEST', 'work id must be a non-empty string');
    workItems = workItems.filter((workItem) => workItem.id === options.id
      || workItem.runs.some((run) => run.attempt?.id === options.id));
    if (!workItems.length) throw brokerError('NOT_FOUND', `Work item or job not found: ${options.id}`);
  }
  if (options.limit != null) {
    const limit = Number(options.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw brokerError('INVALID_REQUEST', 'work limit must be an integer between 1 and 100');
    }
    workItems = workItems.slice(0, limit);
  }
  return { workItems };
}
