function detectCycle(tasks) {
  const graph = new Map();

  for (const task of tasks) {
    graph.set(task.clientId, task.dependencies || []);
  }

  const visited = new Set();
  const visiting = new Set();
  const path = [];

  function visit(taskId) {
    if (visiting.has(taskId)) {
      const cycleStart = path.indexOf(taskId);
      const cyclePath = [...path.slice(cycleStart), taskId];

      return cyclePath;
    }

    if (visited.has(taskId)) {
      return null;
    }

    visiting.add(taskId);
    path.push(taskId);

    const dependencies = graph.get(taskId) || [];

    for (const dependencyId of dependencies) {
      const cycle = visit(dependencyId);

      if (cycle) {
        return cycle;
      }
    }

    path.pop();
    visiting.delete(taskId);
    visited.add(taskId);

    return null;
  }

  for (const taskId of graph.keys()) {
    const cycle = visit(taskId);

    if (cycle) {
      return cycle;
    }
  }

  return null;
}

module.exports = detectCycle;