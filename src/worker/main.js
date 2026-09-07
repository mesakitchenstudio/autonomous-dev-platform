import { loadDotEnv, boolEnv } from '../util/env.js';
import { createRuntime } from '../app/runtime.js';
import { Worker } from './worker.js';

loadDotEnv();
process.env.APP_ROLE = 'worker';
const runtime = await createRuntime({ role: 'worker', demo: boolEnv('DEMO_MODE', false) });
const worker = new Worker({
  store: runtime.store,
  queue: runtime.queue,
  orchestrator: runtime.orchestrator
});
await runtime.orchestrator.recoverOnBoot();
await worker.start();
console.log(`Autonomous worker ${worker.workerId} (${runtime.engine}) polling durable jobs.`);

async function shutdown(signal) {
  console.log(`Worker received ${signal}; stopping claims.`);
  await worker.stop();
  await runtime.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
