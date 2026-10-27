import React, { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { Link, useNavigate } from "react-router-dom";
import superjson from "superjson";
import { LangSwitch } from "../components/LangSwitch";
import { Input } from "../components/Input";
import { Button } from "../components/Button";
import { Spinner } from "../components/Spinner";
import { useLang } from "../helpers/uiLang";
import { useAuth } from "../helpers/useAuth";
import type { User } from "../helpers/User";
import styles from "./auth.module.css";

// Récupération du compte (27/10/2026) : l'e-mail reçoit un code à 6 chiffres,
// puis on choisit un nouveau mot de passe et on est connecté directement.

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/_api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: superjson.stringify(body),
    credentials: "include",
  });
  const text = await res.text();
  let data: { message?: string } & Record<string, unknown> = {};
  try { data = superjson.parse(text); } catch { /* réponse vide */ }
  if (!res.ok) throw new Error(data.message || "Erreur, réessaie.");
  return data as T;
}

const box: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 14 };
const label: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 14, fontWeight: 600 };
const err: React.CSSProperties = { padding: "10px 12px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", fontSize: 14, lineHeight: 1.45 };
const ok: React.CSSProperties = { padding: "10px 12px", borderRadius: 10, background: "#ecfdf5", border: "1px solid #a7f3d0", color: "#065f46", fontSize: 14, lineHeight: 1.45 };

export default function ForgotPasswordPage() {
  const { lang, setLang, t } = useLang();
  const { onLogin } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [wait, setWait] = useState(0);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const sendCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null); setInfo(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError(t("Écris l'e-mail de ton compte.", "Enter your account e-mail.")); return; }
    setBusy(true);
    try {
      const r = await post<{ message: string }>("forgot_password", { email: email.trim() });
      setInfo(r.message);
      setStep("code");
      setWait(60);
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x));
    } finally { setBusy(false); }
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code.trim())) { setError(t("Le code contient 6 chiffres.", "The code has 6 digits.")); return; }
    if (pass.length < 8) { setError(t("Le mot de passe doit faire au moins 8 caractères.", "Password must be at least 8 characters.")); return; }
    if (pass !== pass2) { setError(t("Les deux mots de passe ne sont pas pareils.", "The two passwords don't match.")); return; }
    setBusy(true);
    try {
      const r = await post<{ user: User; token: string }>("reset_password", { email: email.trim(), code: code.trim(), password: pass, device: navigator.userAgent.slice(0, 120) });
      onLogin(r.user, r.token);
      setTimeout(() => navigate("/"), 200);
    } catch (x) {
      setError(x instanceof Error ? x.message : String(x));
    } finally { setBusy(false); }
  };

  return (
    <>
      <Helmet><title>{t("Mot de passe oublié", "Forgotten password")} · Maintenance Control Room</title></Helmet>
      <main className={styles.page}>
        <section className={styles.card}>
          <LangSwitch lang={lang} onChange={setLang} />
          <div className={styles.brand}><div className={styles.mark}>MC</div><div><b>MAINTENANCE</b><span>CONTROL ROOM</span></div></div>
          <h1>{t("Récupérer mon compte", "Recover my account")}</h1>

          {step === "email" ? (
            <form style={box} onSubmit={sendCode}>
              <p className={styles.sub} style={{ margin: "8px 0 4px" }}>{t("Écris l'e-mail de ton compte : on t'envoie un code à 6 chiffres.", "Enter your account e-mail: we'll send you a 6-digit code.")}</p>
              {error && <div style={err}>{error}</div>}
              <label style={label}>E-mail
                <Input type="email" autoComplete="email" placeholder="ton@email.com" value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <Button type="submit" disabled={busy}>{busy ? <><Spinner size="sm" /> {t("Envoi…", "Sending…")}</> : t("Recevoir le code", "Get the code")}</Button>
            </form>
          ) : (
            <form style={box} onSubmit={reset}>
              {info && <div style={ok}>{info}</div>}
              {error && <div style={err}>{error}</div>}
              <label style={label}>{t("Code reçu par e-mail", "Code received by e-mail")}
                <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code} disabled={busy}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} style={{ letterSpacing: 6, fontSize: 20, fontFamily: "monospace" }} />
              </label>
              <label style={label}>{t("Nouveau mot de passe", "New password")}
                <Input type="password" autoComplete="new-password" placeholder={t("8 caractères minimum", "8 characters minimum")} value={pass} disabled={busy} onChange={(e) => setPass(e.target.value)} />
              </label>
              <label style={label}>{t("Confirmer le mot de passe", "Confirm password")}
                <Input type="password" autoComplete="new-password" value={pass2} disabled={busy} onChange={(e) => setPass2(e.target.value)} />
              </label>
              <Button type="submit" disabled={busy}>{busy ? <><Spinner size="sm" /> {t("Enregistrement…", "Saving…")}</> : t("Changer le mot de passe", "Change password")}</Button>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14 }}>
                <button type="button" style={{ background: "none", border: 0, padding: 0, color: "#667085", cursor: "pointer", font: "inherit" }}
                  onClick={() => { setStep("email"); setError(null); setInfo(null); setCode(""); }}>{t("Changer d'e-mail", "Change e-mail")}</button>
                <button type="button" disabled={busy || wait > 0} style={{ background: "none", border: 0, padding: 0, color: wait > 0 ? "#98a2b3" : "#0b5cff", fontWeight: 600, cursor: wait > 0 ? "default" : "pointer", font: "inherit" }}
                  onClick={() => void sendCode()}>{wait > 0 ? t(`Renvoyer (${wait} s)`, `Resend (${wait}s)`) : t("Renvoyer le code", "Resend code")}</button>
              </div>
            </form>
          )}

          <p className={styles.switch}><Link to="/login">{t("Retour à la connexion", "Back to sign in")}</Link></p>
        </section>
      </main>
    </>
  );
}
