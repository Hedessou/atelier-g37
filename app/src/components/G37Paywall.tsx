import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";
import { g37Plans, type G37PlanKey, type G37QuotaStatus } from "../helpers/g37Plans";
import { postG37Subscribe } from "../endpoints/g37/subscribe_POST.schema";
import { getG37Quota } from "../endpoints/g37/quota_GET.schema";
import { getG37PayNetworks } from "../endpoints/g37/pay_networks_GET.schema";
import { openExternal } from "../lib/links";
import styles from "./G37Paywall.module.css";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "ai" | "calc";
  quota: G37QuotaStatus | null;
  lang: "fr" | "en";
  onQuota: (q: G37QuotaStatus) => void;
  className?: string;
};

const COUNTRIES = [
  ["TG", "Togo"], ["BJ", "Bénin"], ["CI", "Côte d'Ivoire"], ["BF", "Burkina Faso"],
  ["SN", "Sénégal"], ["ML", "Mali"], ["NE", "Niger"],
] as const;

const fcfa = (n: number) => `${n.toLocaleString("fr-FR")} F`;
const POLL_MS = 5000;
const POLL_MAX = 36; // ≈ 3 minutes d'attente de la confirmation sur le téléphone

export const G37Paywall = ({ open, onOpenChange, kind, quota, lang, onQuota, className }: Props) => {
  const t = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const [plan, setPlan] = useState<G37PlanKey>("day");
  const [country, setCountry] = useState<string>("TG");
  const [networkPick, setNetwork] = useState("");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpNeeded, setOtpNeeded] = useState<string | null>(null);
  const [busy, setBusy] = useState<"pay" | "check" | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const pollToken = useRef(0);

  const pending = choosing ? null : quota?.pendingRequest ?? null;
  const limit = quota?.[kind].limit ?? g37Plans.FREE_PER_DAY;
  const what = kind === "ai"
    ? t(`question${limit > 1 ? "s" : ""} à l'IA`, `AI question${limit > 1 ? "s" : ""}`)
    : t(`calcul${limit > 1 ? "s" : ""}`, `calculation${limit > 1 ? "s" : ""}`);
  const chosen = g37Plans.byKey(plan)!;

  // Réseaux mobile money du pays choisi (chargés seulement quand la fenêtre est ouverte).
  const networksQuery = useQuery({
    queryKey: ["g37", "payNetworks", country],
    queryFn: () => getG37PayNetworks(country),
    enabled: open,
    staleTime: 10 * 60_000,
  });
  const networks = networksQuery.isFetching && !networksQuery.data ? null : networksQuery.data?.networks ?? (networksQuery.isError ? [] : null);
  const network = networks?.some((n) => n.code === networkPick) ? networkPick : networks?.[0]?.code ?? "";

  const stopPolling = () => { pollToken.current += 1; setWaiting(false); };

  const done = (q: G37QuotaStatus) => {
    pollToken.current += 1;
    onQuota(q);
    toast.success(t("Paiement confirmé : accès illimité activé.", "Payment confirmed: unlimited access is on."));
    setChoosing(false);
    setWaiting(false);
    onOpenChange(false);
  };

  // Attente de la confirmation faite sur le téléphone : on revérifie régulièrement auprès du serveur.
  const startPolling = () => {
    const token = ++pollToken.current;
    setWaiting(true);
    let count = 0;
    const tick = async () => {
      if (token !== pollToken.current) return;
      count += 1;
      try {
        const q = await getG37Quota();
        if (token !== pollToken.current) return;
        if (q.unlimited) { done(q); return; }
        onQuota(q);
        if (!q.pendingRequest) {
          stopPolling();
          toast.error(t("Le paiement n'a pas abouti (refusé ou annulé). Tu peux réessayer.", "The payment did not go through (declined or cancelled). You can try again."));
          return;
        }
      } catch { /* réseau instable : on réessaie */ }
      if (count >= POLL_MAX) { stopPolling(); return; }
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
  };
  useEffect(() => () => { pollToken.current += 1; }, []);

  const pay = async () => {
    setBusy("pay");
    try {
      const res = await postG37Subscribe({ plan, country, network, phone, otp: otp || undefined });
      if (res.otpRequired) {
        setOtpNeeded(res.message ?? t("Ce réseau demande un code de paiement avant de payer.", "This network needs a payment code first."));
        return;
      }
      if (res.quota) onQuota(res.quota);
      if (res.activated && res.quota) { done(res.quota); return; }
      setChoosing(false);
      setOtp("");
      setOtpNeeded(null);
      if (res.checkoutUrl) { void openExternal(res.checkoutUrl); return; }
      startPolling();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Paiement impossible.", "Payment unavailable."));
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setBusy("check");
    try {
      const q = await getG37Quota();
      if (q.unlimited) done(q);
      else {
        onQuota(q);
        if (q.pendingRequest) {
          toast.message(t("Paiement pas encore confirmé. Valide la demande sur ton téléphone avec ton code secret, puis réessaie.", "Payment not confirmed yet. Approve the request on your phone with your PIN, then try again."));
          if (!waiting) startPolling();
        } else {
          toast.message(t("Ce paiement n'a pas abouti. Tu peux choisir une offre et recommencer.", "This payment did not go through. You can pick a plan and try again."));
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Vérification impossible.", "Could not check."));
    } finally {
      setBusy(null);
    }
  };

  const canPay = !!network && phone.replace(/\D/g, "").length >= 8 && (!otpNeeded || otp.trim().length >= 3);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setChoosing(false); stopPolling(); } onOpenChange(o); }}>
      <DialogContent className={`${styles.content} ${className ?? ""}`}>
        <DialogHeader>
          <DialogTitle>{t("Limite gratuite atteinte", "Free limit reached")}</DialogTitle>
          <DialogDescription>
            {limit <= 0
              ? t(`Ton compte n'a pas d'utilisation gratuite ${kind === "ai" ? "de l'IA" : "du calcul"}. Abonne-toi pour y accéder sans limite.`,
                  `Your account has no free ${kind === "ai" ? "AI" : "calculator"} use. Subscribe for unlimited access.`)
              : t(`Tu as utilisé tes ${limit} ${what} gratuit${limit > 1 ? "s" : ""} d'aujourd'hui. Abonne-toi pour continuer sans limite, ou attends demain.`,
                  `You have used your ${limit} free ${what} for today. Subscribe to continue without limits, or wait until tomorrow.`)}
          </DialogDescription>
        </DialogHeader>

        {pending ? (
          <div className={styles.pending}>
            <strong>{waiting ? t("Confirme sur ton téléphone", "Confirm on your phone") : t("Paiement en attente", "Payment pending")}</strong>
            <span>
              {t(`${g37Plans.byKey(pending.plan)?.fr ?? pending.plan} · ${fcfa(pending.amount)}. Une demande de paiement est envoyée sur ton numéro Mobile Money : valide-la avec ton code secret. Si rien n'arrive, compose le menu de ton opérateur (ex. *145# Moov, *555# Mixx) pour voir les paiements en attente.`,
                `${g37Plans.byKey(pending.plan)?.en ?? pending.plan} · ${fcfa(pending.amount)}. A payment request is sent to your Mobile Money number: approve it with your PIN. If nothing arrives, open your operator's USSD menu to see pending payments.`)}
            </span>
            {waiting && <span className={styles.waiting}>{t("En attente de la confirmation…", "Waiting for confirmation…")}</span>}
            <div className={styles.pendingActions}>
              {pending.checkoutUrl && (
                <Button asChild variant="secondary" size="sm">
                  <a href={pending.checkoutUrl}>{t("Ouvrir la page de paiement", "Open the payment page")}</a>
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => { setChoosing(true); stopPolling(); }}>{t("Recommencer / autre offre", "Start over / other plan")}</Button>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.plans} role="radiogroup" aria-label={t("Offres", "Plans")}>
              {g37Plans.list.map((p) => (
                <button key={p.key} type="button" role="radio" aria-checked={plan === p.key}
                  className={`${styles.plan} ${plan === p.key ? styles.planActive : ""}`} onClick={() => setPlan(p.key)}>
                  <span className={styles.price}>{fcfa(p.price)}</span>
                  <span className={styles.planName}>{lang === "fr" ? p.fr : p.en}</span>
                </button>
              ))}
            </div>
            <div className={styles.fields}>
              <div className={styles.twoCols}>
                <label className={styles.field}><span>{t("Pays", "Country")}</span>
                  <Select value={country} onValueChange={(v) => { setCountry(v); setNetwork(""); setOtpNeeded(null); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{COUNTRIES.map(([c, n]) => <SelectItem key={c} value={c}>{n}</SelectItem>)}</SelectContent>
                  </Select>
                </label>
                <label className={styles.field}><span>{t("Réseau", "Network")}</span>
                  {networks === null ? (
                    <div className={styles.loadingField}>{t("Chargement…", "Loading…")}</div>
                  ) : networks.length === 0 ? (
                    <div className={styles.loadingField}>{t("Aucun réseau disponible", "No network available")}</div>
                  ) : (
                    <Select value={network} onValueChange={(v) => { setNetwork(v); setOtpNeeded(null); }}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{networks.map((n) => <SelectItem key={n.code} value={n.code}>{n.name}</SelectItem>)}</SelectContent>
                    </Select>
                  )}
                </label>
              </div>
              <label className={styles.field}><span>{t("Numéro Mobile Money", "Mobile Money number")}</span>
                <Input inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={country === "TG" ? "90 12 34 56" : t("Ton numéro", "Your number")} /></label>
              {otpNeeded && (
                <label className={styles.field}><span>{t("Code de paiement", "Payment code")}</span>
                  <span className={styles.otpHint}>{otpNeeded}</span>
                  <Input inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value)} /></label>
              )}
            </div>
            <p className={styles.howto}>
              {t("Paiement sécurisé par SasPay. Une demande arrive sur ton téléphone : valide-la avec ton code secret Mobile Money et l'illimité s'active tout seul.",
                "Secure payment by SasPay. A request arrives on your phone: approve it with your Mobile Money PIN and unlimited access turns on automatically.")}
            </p>
          </>
        )}

        <div className={styles.actions}>
          <Button variant="outline" onClick={() => { stopPolling(); onOpenChange(false); }}>{t("Attendre demain", "Wait until tomorrow")}</Button>
          {pending ? (
            <Button disabled={busy !== null} onClick={() => void check()}>{busy === "check" ? t("Vérification…", "Checking…") : t("J'ai validé, vérifier", "I approved, check")}</Button>
          ) : (
            <Button disabled={busy !== null || !canPay} onClick={() => void pay()}>{busy === "pay" ? t("Envoi…", "Sending…") : t(`Payer ${fcfa(chosen.price)}`, `Pay ${fcfa(chosen.price)}`)}</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

