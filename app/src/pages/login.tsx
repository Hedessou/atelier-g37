import React from "react";
import { Helmet } from "react-helmet";
import { Link } from "react-router-dom";
import { PasswordLoginForm } from "../components/PasswordLoginForm";
import { LangSwitch } from "../components/LangSwitch";
import { useLang } from "../helpers/uiLang";
import styles from "./auth.module.css";

export default function LoginPage() {
  const { lang, setLang, t } = useLang();
  return <><Helmet><title>{t("Connexion", "Sign in")} · Maintenance Control Room</title></Helmet>
    <main className={styles.page}><section className={styles.card}>
      <LangSwitch lang={lang} onChange={setLang} />
      <div className={styles.brand}><div className={styles.mark}>MC</div><div><b>MAINTENANCE</b><span>CONTROL ROOM</span></div></div>
      <h1>{t("Connexion", "Sign in")}</h1><p className={styles.sub}>{t("Accédez au suivi industriel de votre équipe.", "Access your team's industrial tracking.")}</p>
      <PasswordLoginForm lang={lang} />
      <p className={styles.switch}>{t("Pas encore de compte ?", "No account yet?")} <Link to="/register">{t("Créer un compte", "Create an account")}</Link></p>
    </section></main></>;
}

