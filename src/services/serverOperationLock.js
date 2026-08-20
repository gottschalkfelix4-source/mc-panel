'use strict';

const operations = new Map();

function withServerOperation(serverId, operation) {
  const key = Number(serverId);
  const previous = operations.get(key) || Promise.resolve();
  const current = previous.then(operation, operation);
  operations.set(key, current);
  current.finally(() => {
    if (operations.get(key) === current) operations.delete(key);
  }).catch(() => {});
  return current;
}

module.exports = { withServerOperation };
