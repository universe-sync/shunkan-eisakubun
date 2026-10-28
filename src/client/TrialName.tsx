import { useEffect, useRef, useState, type FormEvent } from "react";
import { APP_NAME } from "../shared/app-info.js";
import { LINK_CODE_DIGITS, NAME_MAX_CHARS, NAME_RULE_MESSAGE, normalizeDisplayName, normalizeLinkCode } from "../shared/trial-rules.js";
import { apiFetch } from "./api.js";
import { TRIAL } from "./strings.js";

// お試しモード：名前を決める画面。重複の文はサーバーの答え（409）をそのまま出す
export default function TrialName() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [done, setDone] = useState<{ name: string; code: string } | null>(null);
  const sending = useRef(false);
  const codeInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (needCode) codeInput.current?.focus(); }, [needCode]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending.current) return;
    if (normalizeDisplayName(name) === null) { setError(NAME_RULE_MESSAGE); return; }
    const withCode = needCode && code.replace(/\s+/g, "") !== "";
    if (withCode && normalizeLinkCode(code) === null) { setError(TRIAL.codeBadNumber); return; }
    sending.current = true; setBusy(true); setError("");
    try {
      let status = 0; let body: { error?: unknown; reason?: unknown; name?: unknown; code?: unknown } | null = null;
      try {
        const response = await apiFetch("/trial/name", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withCode ? { name, code } : { name }) });
        status = response.status;
        body = await response.json().catch(() => null);
      } catch { status = 0; }
      if (status === 200) {
        // 番号を使って入った人は、そのまま続きへ。初めての登録なら番号を見せてから
        if (withCode || typeof body?.code !== "string") { location.replace("/"); return; }
        setDone({ name: typeof body.name === "string" ? body.name : name.trim(), code: body.code });
        return;
      }
      if (status === 401) { location.replace("/login"); return; }
      if (status === 409 && body?.reason === "name_taken") setNeedCode(true);
      setError(status === 0 ? TRIAL.network : typeof body?.error === "string" && body.error ? body.error : TRIAL.error);
    } finally { sending.current = false; setBusy(false); }
  };

  if (done) {
    return <main className="login">
      <div className="login-card">
        <h1>{APP_NAME}</h1>
        <h2>{TRIAL.registered(done.name)}</h2>
        <p className="note">{TRIAL.codeHeading}</p>
        <p className="trial-code-digits" aria-label={TRIAL.codeHeading}>{done.code}</p>
        <p className="note">{TRIAL.registeredNote}</p>
        <button type="button" onClick={() => location.replace("/")}>{TRIAL.registeredStart}</button>
      </div>
    </main>;
  }

  return <main className="login">
    <form className="login-card" onSubmit={(event) => void submit(event)}>
      <h1>{APP_NAME}</h1>
      <h2>{TRIAL.nameTitle}</h2>
      <label>{TRIAL.nameLabel}
        <input type="text" name="name" autoComplete="off" autoFocus maxLength={NAME_MAX_CHARS * 2} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {needCode
        ? <><label>{TRIAL.codeLabel}
          <input ref={codeInput} type="text" name="link-code" inputMode="numeric" autoComplete="one-time-code" maxLength={LINK_CODE_DIGITS * 2} value={code} onChange={(event) => setCode(event.target.value)} />
        </label><p className="note">{TRIAL.codeHint}</p></>
        : <button type="button" className="quiet" onClick={() => setNeedCode(true)}>{TRIAL.codeToggle}<br />{TRIAL.codeToggleSub}</button>}
      <button type="submit" disabled={busy || name.trim() === ""}>{busy ? TRIAL.nameSubmitting : TRIAL.nameSubmit}</button>
      <p className="login-error" role="alert">{error}</p>
      <ul className="note trial-name-notes">{TRIAL.nameNotes.map((line) => <li key={line}>{line}</li>)}</ul>
    </form>
  </main>;
}
