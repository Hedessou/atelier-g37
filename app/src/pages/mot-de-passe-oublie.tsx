import React from "react";
import { Helmet } from "react-helmet";
import { Link } from "react-router-dom";
import { LangSwitch } from "../components/LangSwitch";
import { useLang } from "../helpers/uiLang";
import styles from "./auth.module.css";

export default function ForgotPasswordPage() {
  const { lang, setLang, t } = useLang();
  return (
    <>
      <Helmet><title>{t("Mot de passe oublié", "Forgotten password")} · Maintenance Control Room</title></Helmet>
      <main className={styles.page}>
        <section className={styles.card}>
          <LangSwitch lang={lang} onChange={setLang} />
          <div className={styles.brand}><div className={styles.mark}>MC</div><div><b>MAINTENANCE</b><span>CONTROL ROOM</span></div></div>
          <h1>{t("Récupérer mon compte", "Recover my account")}</h1>
          <p className={styles.sub}>{t("Tu as oublié ton mot de passe ?", "Forgot your password?")}</p>
          <div style={{ padding: 14, borderRadius: 12, background: "color-mix(in srgb, var(--accent) 8%, transparent)", lineHeight: 1.55 }}>
            {t("Pour le moment, la récupération est gérée par l'administrateur de l'atelier. Il peut réinitialiser ton mot de passe depuis ", "For now, recovery is handled by the workshop administrator. They can reset your password from ")}<strong>{t("Accès → Équipe", "Access → Team")}</strong>{t(" sans supprimer ton compte ni tes données.", " without deleting your account or your data.")}
          </div>
          <p className={styles.switch}><Link to="/login">{t("Retour à la connexion", "Back to sign in")}</Link></p>
        </section>
      </main>
    </>
  );
}

