import type { Env as WorkerEnv } from "../src/types.js";
declare global { namespace Cloudflare { interface Env extends WorkerEnv {} } }
