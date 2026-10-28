import { useRef, useState, type FormEvent } from "react";
import { APP_NAME } from "../shared/app-info.js";
import { apiFetch } from "./api.js";
import { formatYen } from "./lib/usage-format.js";
import { TRIAL } from "./strings.js";

type Participant = { name: string; code: string; todayQuestions: number; totalQuestions: number; todaySpeech: number; lastSeenAt: string; createdAt: string };
type Report = { date: string; todayJpy: number; daily: { answers: { used: number; limit: number }; speech: { used: number; limit: number }; yen: { used: number; limit: number } }; participants: Participant[] };
const when = (iso: string): string => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

// お試しモード：管理用の参加者の一覧（オーナーだけ）。管理用の合言葉は入力欄と ref の中だけに置き、保存しない
export default function TrialAdmin() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const token = useRef("");
  const input = useRef<HTMLInputElement | null>(null);
  const sending = useRef(false);

  const load = async () => {
    if (sending.current || token.current.trim() === "") return;
    sending.current = true; setBusy(true); setError("");
    try {
      let status = 0; let body: (Partial<Report> & { error?: unknown }) | null = null;
      try {
        const response = await apiFetch("/trial/admin/participants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: token.current }) });
        status = response.status;
        body = await response.json().catch(() => null);
      } catch { status = 0; }
      if (status === 401) { location.replace("/login"); return; }
      if (status === 200 && body && Array.isArray(body.participants)) { setReport(body as Report); return; }
      setReport(null);
      setError(status === 0 ? TRIAL.adminNetwork : typeof body?.error === "string" && body.error ? body.error : TRIAL.adminError);
    } finally { sending.current = false; setBusy(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); token.current = input.current?.value ?? ""; void load(); };

  return <main className="trial-admin">
    <header><p className="eyebrow">{APP_NAME}</p><h1>{TRIAL.adminTitle}</h1></header>
    <section>
      <form onSubmit={submit}>
        <label>{TRIAL.adminLabel}<input ref={input} type="password" name="admin-token" autoComplete="off" autoFocus /></label>
        <button type="submit" disabled={busy}>{busy ? TRIAL.adminLoading : TRIAL.adminSubmit}</button>
        {report && <button type="button" className="quiet" disabled={busy} onClick={() => void load()}>{TRIAL.adminReload}</button>}
        <p className="login-error" role="alert">{error}</p>
      </form>
    </section>
    {report && <section>
      <p className="note">{report.date}（日本時間）の全員の合計：利用料の目安 {formatYen(report.todayJpy)}（上限 {report.daily.yen.limit}円）・採点 {report.daily.answers.used} / {report.daily.answers.limit}回・読み上げ {report.daily.speech.used} / {report.daily.speech.limit}回</p>
      {report.participants.length === 0 ? <p>{TRIAL.adminEmpty}</p> : <div className="trial-admin-scroll"><table>
        <thead><tr><th>名前</th><th>{TRIAL.adminCode}</th><th>今日の問題</th><th>累計の問題</th><th>今日の読み上げ</th><th>最後に使った日時</th><th>登録日時</th></tr></thead>
        <tbody>{report.participants.map((p) => <tr key={p.name + p.createdAt}><td>{p.name}</td><td>{p.code}</td><td>{p.todayQuestions}</td><td>{p.totalQuestions}</td><td>{p.todaySpeech}</td><td>{when(p.lastSeenAt)}</td><td>{when(p.createdAt)}</td></tr>)}</tbody>
      </table></div>}
    </section>}
  </main>;
}
