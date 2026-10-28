import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { APP_HEADING, APP_TAGLINE } from "../shared/app-info.js";
import { apiFetch } from "./api.js";
import InstantPractice from "./InstantPractice.js";
import Login from "./Login.js";
import { TRIAL, LOGIN } from "./strings.js";
import { type TrialInfo } from "./lib/trial-view.js";
import TrialAdmin from "./TrialAdmin.js";
import TrialBar from "./TrialBar.js";
import TrialName from "./TrialName.js";
import UsageBar from "./UsageBar.js";
import "./styles.css";

// unknown＝status を読むまで（1人用と同じ見た目で出す）／solo＝1人用／trial＝お試し／trial-name＝名前の登録がまだ
type Mode = "unknown" | "solo" | "trial" | "trial-name";

function App() {
  const [active, setActive] = useState(false); // 出題の実行中はログアウトできない
  const [mode, setMode] = useState<Mode>("unknown");
  const [trial, setTrial] = useState<TrialInfo | null>(null);
  const logout = async () => {
    try { await apiFetch("/logout", { method: "POST" }); } catch { /* 通信できなくても、ログイン画面へ移す */ }
    location.replace("/login");
  };
  // 引き継ぎ番号のモーダル。開くときに一度だけ読む（読めたら持っておく）
  const codeDialog = useRef<HTMLDialogElement | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeError, setCodeError] = useState(false);
  const loading = useRef(false);
  const openCode = async () => {
    if (active) return;
    codeDialog.current?.showModal();
    if (code !== null || loading.current) return;
    loading.current = true; setCodeError(false);
    try {
      let status = 0; let body: { code?: unknown; reason?: unknown } | null = null;
      try {
        const response = await apiFetch("/trial/code", { method: "POST" });
        status = response.status;
        body = await response.json().catch(() => null);
      } catch { status = 0; }
      if (status === 401) { location.replace("/login"); return; }
      if (status === 403 && body?.reason === "trial_name_required") { location.replace("/"); return; }
      if (status === 200 && typeof body?.code === "string") setCode(body.code); else setCodeError(true);
    } finally { loading.current = false; }
  };
  // この端末から抜ける：名前の cookie を消して名前の画面へ（記録は残り、名前と引き継ぎ番号でまた入れる）
  const leaveDevice = async () => {
    if (active || !window.confirm(TRIAL.leaveConfirm)) return;
    try { await apiFetch("/trial/leave", { method: "POST" }); } catch { /* 通信できなくても、読み込み直す */ }
    location.replace("/");
  };
  const logoutButton = <button type="button" className="quiet logout" disabled={active} onClick={() => void logout()}>{LOGIN.logout}</button>;
  if (mode === "trial-name") return <TrialName />;
  const isTrial = mode === "trial";
  return <>{isTrial ? <TrialBar trial={trial} /> : <UsageBar />}<main><header><p className="eyebrow">{APP_TAGLINE}</p><div className="header-row"><h1>{APP_HEADING}</h1>{isTrial ? <span className="title-row"><button type="button" className="quiet logout" disabled={active} aria-haspopup="dialog" onClick={() => void openCode()}>{TRIAL.showCode}</button>{logoutButton}</span> : logoutButton}</div></header><InstantPractice onActiveChange={setActive} onMode={setMode} onTrial={setTrial} /></main>{isTrial && <dialog ref={codeDialog} className="help-dialog" aria-labelledby="code-title" onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="help-body">
      <div className="help-head"><h2 id="code-title">{TRIAL.codeDialogTitle}</h2><button type="button" className="quiet help-close" aria-label={TRIAL.close} onClick={() => codeDialog.current?.close()}>×</button></div>
      <h3>{TRIAL.codeOf(trial?.name ?? "")}</h3>
      {code !== null ? <p className="trial-code-digits">{code}</p> : <p className="note" role="status">{codeError ? TRIAL.codeLoadError : TRIAL.codeLoading}</p>}
      <p>{TRIAL.codeUse}</p>
      <p>{TRIAL.codeNoSimul}</p>
      <p><button type="button" className="quiet" disabled={active} onClick={() => void leaveDevice()}>{TRIAL.leaveDevice}</button></p>
      <p className="help-foot"><button type="button" onClick={() => codeDialog.current?.close()}>{TRIAL.close}</button></p>
    </div>
  </dialog>}</>;
}
const path = location.pathname;
createRoot(document.getElementById("root")!).render(path === "/login" ? <Login /> : path === "/trial/admin" ? <TrialAdmin /> : <App />);
