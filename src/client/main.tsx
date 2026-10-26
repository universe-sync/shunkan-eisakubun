import { useState } from "react";
import { createRoot } from "react-dom/client";
import { APP_NAME, APP_TAGLINE } from "../shared/app-info.js";
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
  // 名前を変える：今の名前の cookie を消して、名前の画面へ（前の名前の記録は残り、その名前は使用中のまま）
  const changeName = async () => {
    if (active || !window.confirm(TRIAL.changeNameConfirm(trial?.name ?? ""))) return;
    try { await apiFetch("/trial/leave", { method: "POST" }); } catch { /* 通信できなくても、読み込み直す */ }
    location.replace("/");
  };
  const logoutButton = <button type="button" className="quiet logout" disabled={active} onClick={() => void logout()}>{LOGIN.logout}</button>;
  if (mode === "trial-name") return <TrialName />;
  const isTrial = mode === "trial";
  return <>{isTrial ? <TrialBar trial={trial} /> : <UsageBar />}<main><header><p className="eyebrow">{APP_TAGLINE}</p><div className="header-row"><h1>{APP_NAME}</h1>{isTrial ? <span className="title-row"><button type="button" className="quiet logout" disabled={active} onClick={() => void changeName()}>{TRIAL.changeName}</button>{logoutButton}</span> : logoutButton}</div></header><InstantPractice onActiveChange={setActive} onMode={setMode} onTrial={setTrial} /></main></>;
}
const path = location.pathname;
createRoot(document.getElementById("root")!).render(path === "/login" ? <Login /> : path === "/trial/admin" ? <TrialAdmin /> : <App />);
