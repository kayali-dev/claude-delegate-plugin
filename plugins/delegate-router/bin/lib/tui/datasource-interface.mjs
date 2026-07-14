export const DATASOURCE_METHODS = Object.freeze([
  'getState',
  'start',
  'selectJob',
  'reconcileVisibleJobs',
  'refresh',
  'close',
  'on',
  'off'
]);

export function assertDatasourceInterface(source) {
  if (!source || typeof source !== 'object') throw new TypeError('datasource must be an object');
  for (const method of DATASOURCE_METHODS) {
    if (typeof source[method] !== 'function') throw new TypeError(`datasource is missing ${method}()`);
  }
  return source;
}

