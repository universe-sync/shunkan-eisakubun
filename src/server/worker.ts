import { createWorkerApp } from "./app";
import { PRACTICE_NAME, type Env } from "./env";
export { PracticeDO } from "./practice-do";

const app = createWorkerApp<Env>({
  practice: (env) => {
    const stub = env.PRACTICE.get(env.PRACTICE.idFromName(PRACTICE_NAME));
    return { fetch: (req) => stub.fetch(req), loginAttempt: (key, ok, clearOnOk) => stub.loginAttempt(key, ok, clearOnOk), trialRegister: (name, currentKey, resume) => stub.trialRegister(name, currentKey, resume), trialParticipants: () => stub.trialParticipants() };
  },
});

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
