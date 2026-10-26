import { trialBarText, type TrialInfo } from "./lib/trial-view.js";

// お試しモード：画面の上の帯（1人用の UsageBar の代わり）
export default function TrialBar({ trial }: { trial: TrialInfo | null }) {
  return <aside className="usage-bar trial-bar" aria-label="お試しの状況">
    <span className="usage-title">お試し</span>
    <span role="status">{trial ? trialBarText(trial) : "読み込み中"}</span>
  </aside>;
}
