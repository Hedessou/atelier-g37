import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "./Button";
import { Input } from "./Input";
import { Skeleton } from "./Skeleton";
import { getG37UserLimits, type G37UserLimit } from "../endpoints/g37/user_limits_GET.schema";
import { postG37UserLimits } from "../endpoints/g37/user_limits_POST.schema";
import { g37Plans } from "../helpers/g37Plans";
import styles from "./G37LimitsEditor.module.css";

type Props = { lang: "fr" | "en"; roleName: (jobRole: string) => string; className?: string };

// Champ vide = règle par défaut. Sinon un entier de 0 à 1000.
const toText = (v: number | null) => (v === null ? "" : String(v));
const parse = (s: string): number | null | "bad" => {
  const v = s.trim();
  if (v === "") return null;
  if (!/^\d{1,4}$/.test(v) || Number(v) > 1000) return "bad";
  return Number(v);
};

// Réservé au propriétaire du site : limite gratuite par jour de l'IA et du calcul, personne par personne.
export const G37LimitsEditor = ({ lang, roleName, className }: Props) => {
  const t = (fr: string, en: string) => (lang === "fr" ? fr : en);
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<number, { ai: string; calc: string }>>({});
  const query = useQuery({ queryKey: ["g37", "userLimits"], queryFn: () => getG37UserLimits(), placeholderData: (p) => p });
  const save = useMutation({
    mutationFn: postG37UserLimits,
    onSuccess: (_r, vars) => {
      setDrafts((d) => { const n = { ...d }; delete n[vars.userId]; return n; });
      qc.invalidateQueries({ queryKey: ["g37", "userLimits"] });
      toast.success(t("Limites enregistrées.", "Limits saved."));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const draftOf = (u: G37UserLimit) => drafts[u.id] ?? { ai: toText(u.ai), calc: toText(u.calc) };
  const setField = (u: G37UserLimit, k: "ai" | "calc", v: string) => setDrafts((d) => ({ ...d, [u.id]: { ...draftOf(u), [k]: v } }));
  const def = g37Plans.FREE_PER_DAY;

  return (
    <div className={`${styles.card} ${className ?? ""}`}>
      <div className={styles.head}>
        <h2 className={styles.title}>{t("Limites gratuites par personne", "Free limits per person")}</h2>
        <p className={styles.sub}>
          {t(`Nombre de questions IA et de calculs gratuits par jour. Laisse vide pour la règle par défaut (${def} par jour, puis ${g37Plans.FREE_PER_DAY_AFTER_WARNING} après le premier avertissement). Mets 0 pour obliger à s'abonner. Réglage visible par toi seul.`,
            `Free AI questions and calculations per day. Leave empty for the default rule (${def} per day, then ${g37Plans.FREE_PER_DAY_AFTER_WARNING} after the first warning). Set 0 to require a subscription. Only you can see this.`)}
        </p>
      </div>
      {!query.data ? (
        query.isError ? <p className={styles.sub}>{(query.error as Error).message}</p> : <Skeleton style={{ height: 120 }} />
      ) : (
        <div className={styles.list}>
          <div className={`${styles.row} ${styles.headRow}`}>
            <span>{t("Personne", "Person")}</span><span>{t("IA / jour", "AI / day")}</span><span>{t("Calculs / jour", "Calcs / day")}</span><span />
          </div>
          {query.data.users.map((u) => {
            const d = draftOf(u);
            const ai = parse(d.ai);
            const calc = parse(d.calc);
            const changed = d.ai !== toText(u.ai) || d.calc !== toText(u.calc);
            const bad = ai === "bad" || calc === "bad";
            return (
              <div key={u.id} className={styles.row}>
                <div className={styles.who}>
                  <strong>{u.displayName}</strong>
                  <span>{u.isAdmin ? t("Admin · toujours illimité", "Admin · always unlimited") : roleName(u.jobRole)}</span>
                </div>
                <Input className={styles.num} inputMode="numeric" aria-label={t(`IA par jour pour ${u.displayName}`, `AI per day for ${u.displayName}`)}
                  value={d.ai} placeholder={t("auto", "auto")} disabled={u.isAdmin} onChange={(e) => setField(u, "ai", e.target.value)} />
                <Input className={styles.num} inputMode="numeric" aria-label={t(`Calculs par jour pour ${u.displayName}`, `Calculations per day for ${u.displayName}`)}
                  value={d.calc} placeholder={t("auto", "auto")} disabled={u.isAdmin} onChange={(e) => setField(u, "calc", e.target.value)} />
                <Button size="sm" disabled={!changed || bad || save.isPending}
                  onClick={() => save.mutate({ userId: u.id, ai: ai as number | null, calc: calc as number | null })}>
                  {t("Enregistrer", "Save")}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

