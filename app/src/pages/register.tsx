import React from "react";
import { Helmet } from "react-helmet";
import { Link } from "react-router-dom";
import { PasswordRegisterForm } from "../components/PasswordRegisterForm";
import { LangSwitch } from "../components/LangSwitch";
import { useLang } from "../helpers/uiLang";
import styles from "./auth.module.css";

export default function RegisterPage() {
  const { lang, setLang, t } = useLang();
  return <><Helmet><title>{t("Créer un compte", "Create an account")} · Maintenance Control Room</title></Helmet>
    <main className={styles.page}><section className={styles.card}>
      <LangSwitch lang={lang} onChange={setLang} />
      <div className={styles.brand}><div className={styles.mark}>MC</div><div><b>MAINTENANCE</b><span>CONTROL ROOM</span></div></div>
      <h1>{t("Créer un compte", "Create an account")}</h1><p className={styles.sub}>{t("Inscrivez-vous pour rejoindre l’équipe maintenance.", "Sign up to join the maintenance team.")}</p>
      <div className={styles.notice}>{t("Après l’inscription, l’administrateur t’attribue ton poste. En attendant, tu peux consulter l’atelier et signaler une panne.", "After signing up, the administrator assigns your position. Meanwhile, you can view the workshop and report a fault.")}</div>
      <PasswordRegisterForm lang={lang} />
      <p className={styles.switch}>{t("Déjà un compte ?", "Already have an account?")} <Link to="/login">{t("Se connecter", "Sign in")}</Link></p>
    </section></main></>;
}

