let workerModulePromise = null;

async function getWorkerModule(env) {
  if (!workerModulePromise) {
    globalThis.OAK_EDGE_WORKER_BOOT_ENV = env || {};
    workerModulePromise = import('./ops-api-worker.mjs');
  }
  return workerModulePromise;
}

export default {
  async fetch(request, env) {
    const workerModule = await getWorkerModule(env);
    return workerModule.handleWebRequest(request);
  },
};
