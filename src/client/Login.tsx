import { useRef, useState, type FormEvent } from "react";
import { APP_NAME } from "../shared/app-info.js";
import { apiFetch } from "./api.js";
import { loginMessage, loginOutcome } from "./lib/login-result.js";
import { LOGIN } from "./strings.js";

// 合言葉だけのログイン画面（同じ index.html の中で /login のときだけ出す）。ユーザー名は無い
export default function Login() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending.current || password === "") return;
    sending.current = true; setBusy(true); setError("");
    try {
      let status = 0; let body: unknown = null;
      try {
        const response = await apiFetch("/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
        status = response.status;
        body = await response.json().catch(() => null);
      } catch { status = 0; }
      const outcome = loginOutcome(status, body);
      if (outcome.kind === "ok") { location.replace("/"); return; }
      setError(loginMessage(outcome));
    } finally { sending.current = false; setBusy(false); }
  };

  return <main className="login">
    <form className="login-card" onSubmit={(event) => void submit(event)}>
      <h1>{APP_NAME}</h1>
      <label>{LOGIN.label}
        <input type="password" name="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <button type="submit" disabled={busy || password === ""}>{busy ? LOGIN.submitting : LOGIN.submit}</button>
      <p className="login-error" role="alert">{error}</p>
    </form>
  </main>;
}
