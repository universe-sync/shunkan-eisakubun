// 録音の区間の終わり方と、ブラウザでの声の判定から、サーバーへ何を送るかを決める純粋な関数
export type SegmentPlan = "upload" | "no_answer" | "skip";
export function segmentPlan(end: "timeout" | "next" | "stopped", detection: { hasSpeech: boolean } | null): SegmentPlan {
  if (detection === null) return "upload";       // 判定できなかったら、これまでどおりサーバーに任せる
  if (detection.hasSpeech) return "upload";
  return end === "stopped" ? "skip" : "no_answer"; // 声なし：停止の区間は記録しない／時間切れ・次へは「回答なし」を記録する
}
