import test from "node:test";
import assert from "node:assert/strict";
import { forbidNetwork } from "./helpers/no-network";
import { segmentPlan } from "../src/client/lib/segment-plan";

forbidNetwork();

test("声ありなら終わり方にかかわらず送る。声なしは、時間切れ・次へは「回答なし」、停止は送らない", () => {
  for (const end of ["timeout", "next", "stopped"] as const) assert.equal(segmentPlan(end, { hasSpeech: true }), "upload");
  assert.equal(segmentPlan("timeout", { hasSpeech: false }), "no_answer");
  assert.equal(segmentPlan("next", { hasSpeech: false }), "no_answer");
  assert.equal(segmentPlan("stopped", { hasSpeech: false }), "skip");
});

test("判定できなかったとき（null）は、これまでどおりサーバーに送る", () => {
  for (const end of ["timeout", "next", "stopped"] as const) assert.equal(segmentPlan(end, null), "upload");
});
