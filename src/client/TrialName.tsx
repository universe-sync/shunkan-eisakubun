import { useRef, useState, type FormEvent } from "react";
import { APP_NAME } from "../shared/app-info.js";
import { NAME_MAX_CHARS, NAME_RULE_MESSAGE, normalizeDisplayName } from "../shared/trial-rules.js";
import { apiFetch } from "./api.js";
import { TRIAL } from "./strings.js";

// お試しモード：名前を決める画面。重複の文はサーバーの答え（409）をそのまま出す
export default function TrialName() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending.current) return;
    if (normalizeDisplayName(name) === null) { setError(NAME_RULE_MESSAGE); return; }
    sending.current = true; setBusy(true); setError("");
    try {
      let status = 0; let body: { error?: unknown } | null = null;
      try {
        const response = await apiFetch("/trial/name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
        status = response.status;
        body = await response.json().catch(() => null);
      } catch { status = 0; }
      if (status === 200) { location.replace("/"); return; }
      if (status === 401) { location.replace("/login"); return; }
      setError(status === 0 ? TRIAL.network : typeof body?.error === "string" && body.error ? body.error : TRIAL.error);
    } finally { sending.current = false; setBusy(false); }
  };

  return <main className="login">
    <form className="login-card" onSubmit={(event) => void submit(event)}>
      <h1>{APP_NAME}</h1>
      <h2>{TRIAL.nameTitle}</h2>
      <label>{TRIAL.nameLabel}
        <input type="text" name="name" autoComplete="off" autoFocus maxLength={NAME_MAX_CHARS * 2} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button type="submit" disabled={busy || name.trim() === ""}>{busy ? TRIAL.nameSubmitting : TRIAL.nameSubmit}</button>
      <p className="login-error" role="alert">{error}</p>
      <ul className="note trial-name-notes">{TRIAL.nameNotes.map((line) => <li key={line}>{line}</li>)}</ul>
    </form>
  </main>;
}
