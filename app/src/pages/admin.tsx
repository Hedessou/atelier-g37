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
import styles from "./admin.module.css";

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
        <div><div className={styles.eyebrow}>ADMINISTRATION</div><h1>Comptes</h1><p>Gérer les accès à Atelier G37.</p></div>
        <Button asChild><Link to="/">← Retour à l’application</Link></Button>
      </div>
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
      <Helmet><title>Administration · Atelier G37</title></Helmet>
      <AdminRoute><AdminContent /></AdminRoute>
    </>
  );
}

