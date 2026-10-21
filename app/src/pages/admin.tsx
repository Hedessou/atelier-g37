import React, { useEffect, useState } from "react";
import { Helmet } from "react-helmet";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { AdminRoute } from "../components/ProtectedRoute";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { Skeleton } from "../components/Skeleton";
import { getUsers } from "../endpoints/users_GET.schema";
import { updateUserRole } from "../endpoints/userRole_POST.schema";
import { getG37Payments, type OutputType as Payments, type G37PaymentRow } from "../endpoints/g37/payments_GET.schema";
import { postG37PaymentDecide } from "../endpoints/g37/payment_decide_POST.schema";
import { g37Plans } from "../helpers/g37Plans";
import styles from "./admin.module.css";

const fcfa = (n: number) => `${n.toLocaleString("fr-FR")} F`;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const planName = (key: string) => g37Plans.byKey(key)?.fr ?? key;

function PaymentsPanel() {
  const [data, setData] = useState<Payments | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = async () => {
    try {
      setData(await getG37Payments());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Paiements indisponibles.");
    }
  };
  useEffect(() => { void load(); }, []);

  const decide = async (row: G37PaymentRow, approve: boolean) => {
    setBusy(row.id);
    try {
      const res = await postG37PaymentDecide({ id: row.id, approve });
      toast.success(approve ? `Illimité activé pour ${row.userName} jusqu'au ${when(res.endsAt)}.` : `Paiement de ${row.userName} annulé.`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Décision impossible.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.panel}>
      <h2 className={styles.h2}>Abonnements illimités</h2>
      <div className={styles.note}>
        3 questions IA et 3 calculs gratuits par jour, puis 1 par jour à partir du lendemain du premier avertissement.
        Offres : {g37Plans.list.map((p) => `${fcfa(p.price)} = ${p.fr}`).join(" · ")}.
        Les paiements SasPay confirmés activent l'illimité automatiquement : tu n'as rien à faire.
      </div>

      <h3 className={styles.h3}>Paiements SasPay commencés, pas encore confirmés</h3>
      {!data ? (
        <Skeleton style={{ height: 64 }} />
      ) : data.pending.length === 0 ? (
        <p className={styles.empty}>Aucun paiement en attente.</p>
      ) : (
        <div className={styles.list}>
          {data.pending.map((p) => (
            <div className={styles.payRow} key={p.id}>
              <div>
                <strong>{p.userName}</strong>
                <span>{planName(p.plan)} · <b className={styles.mono}>{fcfa(p.amount)}</b> · commencé le {when(p.createdAt)}</span>
                <span>Session SasPay <b className={styles.mono}>{p.checkoutId ?? "—"}</b></span>
              </div>
              <Button variant="outline" disabled={busy === p.id} onClick={() => void decide(p, false)}>Annuler</Button>
              <Button disabled={busy === p.id} onClick={() => void decide(p, true)}>Activer à la main</Button>
            </div>
          ))}
        </div>
      )}

      <h3 className={styles.h3}>Abonnements activés</h3>
      {data && data.recent.length === 0 && <p className={styles.empty}>Aucun abonnement pour l'instant.</p>}
      {data && data.recent.length > 0 && (
        <div className={styles.list}>
          {data.recent.map((p) => {
            const running = !!p.endsAt && new Date(p.endsAt) > new Date();
            return (
              <div className={styles.histRow} key={p.id}>
                <div>
                  <strong>{p.userName}</strong>
                  <span>{planName(p.plan)} · {fcfa(p.amount)} · {p.decidedBy === "SasPay" ? "payé via SasPay" : `activé par ${p.decidedBy ?? "—"}`}</span>
                </div>
                <Badge variant={running ? "success" : "secondary"}>{running ? `Jusqu'au ${when(p.endsAt)}` : "Terminé"}</Badge>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AdminContent() {
  const [users, setUsers] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const load = async () => setUsers((await getUsers()).users);
  useEffect(() => { load(); }, []);
  const role = async (u: any) => {
    setBusy(true);
    try { await updateUserRole({ id: u.id, role: u.role === "admin" ? "user" : "admin" }); await load(); } finally { setBusy(false); }
  };
  return (
    <main className={styles.page}>
      <div className={styles.head}>
        <div><div className={styles.eyebrow}>ADMINISTRATION</div><h1>Comptes et abonnements</h1><p>Gérer les accès et les paiements de Maintenance Control Room.</p></div>
        <Button asChild><Link to="/">← Retour à l’application</Link></Button>
      </div>
      <PaymentsPanel />
      <section className={styles.panel}>
        <h2 className={styles.h2}>Comptes utilisateurs</h2>
        <div className={styles.note}><strong>Administrateurs</strong> : accès complet et illimité. <strong>Utilisateurs</strong> : accès opérationnel.</div>
        <div className={styles.list}>
          {users.map((u) => (
            <div className={styles.row} key={u.id}>
              <div><strong>{u.displayName}</strong><span>{u.email}</span></div>
              <Badge variant={u.role === "admin" ? "warning" : "success"}>{u.role === "admin" ? "ADMIN" : "UTILISATEUR"}</Badge>
              <Button disabled={busy} onClick={() => role(u)}>{u.role === "admin" ? "Retirer admin" : "Nommer admin"}</Button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

export default function AdminPage() {
  return (
    <>
      <Helmet><title>Administration · Maintenance Control Room</title></Helmet>
      <AdminRoute><AdminContent /></AdminRoute>
    </>
  );
}

