import { createWorkerApp } from "./app";
import { PRACTICE_NAME, type Env } from "./env";
export { PracticeDO } from "./practice-do";

const app = createWorkerApp<Env>({
  practice: (env) => {
    const stub = env.PRACTICE.get(env.PRACTICE.idFromName(PRACTICE_NAME));
    return { fetch: (req) => stub.fetch(req), loginAttempt: (key, ok) => stub.loginAttempt(key, ok), trialRegister: (name, currentKey) => stub.trialRegister(name, currentKey), trialParticipants: () => stub.trialParticipants() };
  },
});

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
