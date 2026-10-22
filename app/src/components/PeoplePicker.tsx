import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./Dialog";
import styles from "./PeoplePicker.module.css";

export type Person = { id: number; displayName: string; avatarUrl?: string | null; postTitle?: string | null };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  people: Person[];
  max: number;
  title: string;
  confirmLabel: string;
  exclude?: number[];
  onConfirm: (ids: number[]) => void;
};

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

// Choix de plusieurs collègues (appel de groupe, ajout pendant un appel).
export const PeoplePicker = ({ open, onOpenChange, people, max, title, confirmLabel, exclude = [], onConfirm }: Props) => {
  const [picked, setPicked] = useState<number[]>([]);
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return people.filter((p) => !exclude.includes(p.id) && (!s || p.displayName.toLowerCase().includes(s)))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [people, exclude, q]);
  const toggle = (id: number) => setPicked((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= max ? cur : [...cur, id]);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { setPicked([]); setQ(""); } onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <input className={styles.search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un collègue" aria-label="Rechercher un collègue" />
        <div className={styles.count}>{picked.length} / {max}</div>
        <div className={styles.list}>
          {list.map((p) => {
            const on = picked.includes(p.id);
            return (
              <button key={p.id} className={`${styles.row} ${on ? styles.rowOn : ""}`} onClick={() => toggle(p.id)} aria-pressed={on}>
                {p.avatarUrl ? <img className={styles.avatar} src={p.avatarUrl} alt="" /> : <span className={styles.avatar}>{initials(p.displayName)}</span>}
                <span className={styles.text}><strong>{p.displayName}</strong>{p.postTitle && <span>{p.postTitle}</span>}</span>
                <span className={styles.check} aria-hidden="true">{on ? "✓" : ""}</span>
              </button>
            );
          })}
          {!list.length && <div className={styles.empty}>Aucun collègue.</div>}
        </div>
        <button className={styles.confirm} disabled={!picked.length} onClick={() => { onConfirm(picked); setPicked([]); setQ(""); onOpenChange(false); }}>
          {confirmLabel}{picked.length ? ` (${picked.length})` : ""}
        </button>
      </DialogContent>
    </Dialog>
  );
};
