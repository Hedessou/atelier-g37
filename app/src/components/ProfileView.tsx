import { useRef, useState } from "react";
import { toast } from "sonner";
import type { OutputType as State } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { useOnline } from "../lib/net";
import styles from "./ProfileView.module.css";

type Props = {
  state: State; lang: "fr" | "en"; save: (input: InputType) => void; roleLabel: string;
  onBack: () => void; onLogout: () => void;
};

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

// Photo réduite à 384 px (JPEG) avant l'envoi : rapide même sur un petit réseau.
async function shrink(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, ko) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => ko(new Error("Image illisible"));
      i.src = url;
    });
    const size = 384;
    const scale = Math.max(size / img.width, size / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image illisible");
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return await new Promise<Blob>((ok, ko) => canvas.toBlob((b) => (b ? ok(b) : ko(new Error("Image illisible"))), "image/jpeg", 0.85));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const ProfileView = ({ state, lang, save, roleLabel, onBack, onLogout }: Props) => {
  const t = (a: string, b: string) => (lang === "fr" ? a : b);
  const me = state.users.find((u) => u.id === state.me.id) ?? state.me;
  const online = useOnline();
  const guess = me.displayName.split(" ");
  const [firstName, setFirstName] = useState(me.firstName ?? (me.lastName ? "" : guess[0] ?? ""));
  const [lastName, setLastName] = useState(me.lastName ?? (me.firstName ? "" : guess.slice(1).join(" ")));
  const [postTitle, setPostTitle] = useState(me.postTitle ?? "");
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(me.avatarUrl ?? null);
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      const blob = await shrink(file);
      setPhoto(blob);
      setRemoved(false);
      setPreview(URL.createObjectURL(blob));
    } catch {
      toast.error(t("Cette image ne peut pas être lue.", "This image cannot be read."));
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      let avatarKey: string | null | undefined;
      if (photo) {
        if (!online) throw new Error(t("Il faut Internet pour envoyer la photo. Le reste est enregistré.", "Internet is needed to upload the photo."));
        const res = await fetch("/_api/g37/avatar_upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contentType: "image/jpeg", sizeBytes: photo.size }) });
        const up = await res.json() as { key?: string; presignedUrl?: string; headers?: Record<string, string>; error?: string };
        if (!res.ok || !up.key || !up.presignedUrl) throw new Error(up.error ?? t("Envoi de la photo impossible", "Photo upload failed"));
        const put = await fetch(up.presignedUrl, { method: "PUT", headers: up.headers, body: photo });
        if (!put.ok) throw new Error(t("Envoi de la photo impossible", "Photo upload failed"));
        avatarKey = up.key;
      } else if (removed) {
        avatarKey = null;
      }
      save({ action: "profileInfo", firstName: firstName.trim(), lastName: lastName.trim(), postTitle: postTitle.trim(), ...(avatarKey !== undefined ? { avatarKey } : {}) });
      setPhoto(null);
      toast.success(t("Profil enregistré", "Profile saved"));
    } catch (e) {
      save({ action: "profileInfo", firstName: firstName.trim(), lastName: lastName.trim(), postTitle: postTitle.trim() });
      toast.error(e instanceof Error ? e.message : t("Enregistrement impossible", "Unable to save"));
    } finally {
      setBusy(false);
    }
  };

  const name = [firstName, lastName].filter(Boolean).join(" ") || me.displayName;
  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <button className={styles.back} onClick={onBack} aria-label={t("Retour", "Back")}>‹</button>
        <h1 className={styles.h1}>{t("Mon profil", "My profile")}</h1>
      </div>

      <div className={styles.photoBlock}>
        <button className={styles.photo} onClick={() => fileRef.current?.click()} aria-label={t("Changer la photo", "Change photo")}>
          {preview ? <img src={preview} alt="" /> : <span>{initials(name)}</span>}
          <span className={styles.photoEdit}>{t("Photo", "Photo")}</span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
        {preview && <button className={styles.link} onClick={() => { setPhoto(null); setPreview(null); setRemoved(true); }}>{t("Retirer la photo", "Remove photo")}</button>}
        <div className={styles.who}><strong>{name}</strong><span>{me.email} · {roleLabel}</span></div>
      </div>

      <div className={styles.card}>
        <label className={styles.field}><span>{t("Nom", "Last name")}</span>
          <input value={lastName} maxLength={60} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" /></label>
        <label className={styles.field}><span>{t("Prénom", "First name")}</span>
          <input value={firstName} maxLength={60} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" /></label>
        <label className={styles.field}><span>{t("Poste", "Position")}</span>
          <input value={postTitle} maxLength={80} onChange={(e) => setPostTitle(e.target.value)} placeholder={t("ex. Technicien de maintenance, équipe B", "e.g. Maintenance technician, team B")} /></label>
        <p className={styles.note}>{t("Tes droits dans l'app (grade) restent gérés par l'admin.", "Your app rights (grade) are still managed by the admin.")}</p>
        <button className={styles.primary} disabled={busy || (!firstName.trim() && !lastName.trim())} onClick={() => void submit()}>
          {busy ? t("Enregistrement…", "Saving…") : t("Enregistrer", "Save")}
        </button>
      </div>

      <button className={styles.logout} onClick={() => { if (window.confirm(t("Se déconnecter de ce téléphone ?", "Log out from this phone?"))) onLogout(); }}>
        {t("Déconnexion", "Log out")}
      </button>
    </div>
  );
};
