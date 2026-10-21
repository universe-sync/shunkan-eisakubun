import { useState } from "react";
import { createRoot } from "react-dom/client";
import { APP_NAME, APP_TAGLINE } from "../shared/app-info.js";
import { apiFetch } from "./api.js";
import InstantPractice from "./InstantPractice.js";
import Login from "./Login.js";
import { LOGIN } from "./strings.js";
import UsageBar from "./UsageBar.js";
import "./styles.css";

function App() {
  const [active, setActive] = useState(false); // 出題の実行中はログアウトできない
  const logout = async () => {
    try { await apiFetch("/logout", { method: "POST" }); } catch { /* 通信できなくても、ログイン画面へ移す */ }
    location.replace("/login");
  };
  return <><UsageBar /><main><header><p className="eyebrow">{APP_TAGLINE}</p><div className="header-row"><h1>{APP_NAME}</h1><button type="button" className="quiet logout" disabled={active} onClick={() => void logout()}>{LOGIN.logout}</button></div></header><InstantPractice onActiveChange={setActive} /></main></>;
}
createRoot(document.getElementById("root")!).render(location.pathname === "/login" ? <Login /> : <App />);
