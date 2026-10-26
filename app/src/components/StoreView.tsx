import React, { useMemo, useState } from "react";
import type { OutputType as State, G37StockItem } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { g37 } from "../helpers/g37";
import { Button } from "./Button";
import { Input } from "./Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./Dialog";
import styles from "./StoreView.module.css";

// Magasin : stock, sorties par machine (et par panne), arrivées, inventaire, prix,
// et alerte de réapprovisionnement calculée sur la consommation réelle.

type Mode = "out" | "in" | "count" | "edit" | "add";
const num = (v: string) => { const n = Number(v.replace(",", ".").trim()); return Number.isFinite(n) ? n : NaN; };
const money = (v: number) => Math.round(v).toLocaleString("fr-FR").replace(/ | /g, " ");
const fmtQ = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(".", ","));

function status(s: G37StockItem) {
  const qty = Number(s.quantity);
  const min = Number(s.minimumQuantity || g37.STOCK_ALERT);
  const lead = s.leadDays ?? 14;
  const days = s.daysLeft ?? null;
  const perDay = s.perDay ?? 0;
  const order = qty < min || (days != null && days <= lead);
  // Quantité conseillée : couvrir le délai + 30 jours de consommation, au-dessus du seuil.
  const suggest = Math.max(0, Math.ceil(perDay * (lead + 30) + min - qty));
  return { qty, min, lead, days, order, suggest, empty: qty <= 0 };
}

export function StoreView({ state, lang, save, canStock, canManage }: {
  state: State; lang: "fr" | "en"; save: (input: InputType) => void; canStock: boolean; canManage: boolean;
}) {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("__all");
  const [dlg, setDlg] = useState<{ mode: Mode; item: G37StockItem | null } | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const field = (k: string, def = "") => f[k] ?? def;
  const setField = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const items = state.stock ?? [];
  const cats = useMemo(() => Array.from(new Set(items.map((s) => s.category))).sort(), [items]);
  const list = items.filter((s) => (cat === "__all" || s.category === cat) && (!q.trim() || `${s.name} ${s.category}`.toLowerCase().includes(q.trim().toLowerCase())));
  const toOrder = items.map((s) => ({ s, st: status(s) })).filter((x) => x.st.order).sort((a, b) => (a.st.days ?? -1) - (b.st.days ?? -1));
  const value = items.reduce((a, s) => a + (s.unitPrice != null ? Number(s.unitPrice) * Number(s.quantity) : 0), 0);
  const recent = (state.stockOuts ?? []).slice(0, 8);
  const openFaults = (state.failures ?? []).filter((x) => x.status !== "resolue");

  const open = (mode: Mode, item: G37StockItem | null) => {
    setF(item ? {
      qty: mode === "count" ? String(Number(item.quantity)) : "1", name: item.name, cat: item.category, unit: item.unit,
      min: String(Number(item.minimumQuantity || g37.STOCK_ALERT)), price: item.unitPrice ?? "", lead: String(item.leadDays ?? 14), mc: "__none", fault: "__none", note: "",
    } : { qty: "0", name: "", cat: "", unit: "pcs", min: String(g37.STOCK_ALERT), price: "", lead: "14" });
    setDlg({ mode, item });
  };

  const submit = () => {
    if (!dlg) return;
    const it = dlg.item;
    const qty = num(field("qty"));
    if (dlg.mode === "out" && it) {
      if (!(qty > 0)) return;
      const fault = field("fault", "__none");
      const mc = field("mc", "__none");
      const fl = openFaults.find((x) => x.id === fault);
      save({ action: "stockOut", itemId: it.id, quantity: qty, machineNo: fl ? fl.machineNo : mc === "__none" ? null : Number(mc), failureId: fl ? fl.id : null, note: field("note").trim() || null });
    } else if (dlg.mode === "in" && it) {
      if (!(qty > 0)) return;
      save({ action: "stockIn", itemId: it.id, quantity: qty, note: field("note").trim() || null });
    } else if (dlg.mode === "count" && it) {
      if (!(qty >= 0)) return;
      save({ action: "stockQty", id: it.id, quantity: qty });
    } else if (dlg.mode === "edit" && it) {
      const price = field("price").trim() === "" ? null : num(field("price"));
      save({
        action: "stockEdit", id: it.id, name: field("name").trim(), category: field("cat").trim(), unit: field("unit").trim() || "pcs",
        minimumQuantity: Math.max(0, num(field("min")) || 0), unitPrice: price != null && price >= 0 ? price : null,
        leadDays: Math.min(365, Math.max(1, Math.round(num(field("lead")) || 14))),
      });
    } else if (dlg.mode === "add") {
      const price = field("price").trim() === "" ? null : num(field("price"));
      save({
        action: "stockAdd", name: field("name").trim(), category: field("cat").trim(), unit: field("unit").trim() || "pcs",
        quantity: Math.max(0, num(field("qty")) || 0), minimumQuantity: Math.max(0, num(field("min")) || 0),
        unitPrice: price != null && price >= 0 ? price : null, leadDays: Math.min(365, Math.max(1, Math.round(num(field("lead")) || 14))),
      });
    }
    setDlg(null);
  };

  const qtyOk = (() => {
    if (!dlg) return false;
    const v = num(field("qty"));
    if (dlg.mode === "edit") return !!field("name").trim() && !!field("cat").trim();
    if (dlg.mode === "add") return !!field("name").trim() && !!field("cat").trim() && v >= 0;
    if (dlg.mode === "count") return v >= 0;
    return v > 0;
  })();

  const stepper = (
    <div className={styles.stepper}>
      <button type="button" className={styles.stepBtn} aria-label="−" onClick={() => setField("qty", String(Math.max(0, (num(field("qty")) || 0) - 1)))}>−</button>
      <Input inputMode="decimal" className={styles.stepInput} value={field("qty")} onChange={(e) => setField("qty", e.target.value)} aria-label={t("Quantité", "Quantity")} />
      <button type="button" className={styles.stepBtn} aria-label="+" onClick={() => setField("qty", String((num(field("qty")) || 0) + 1))}>+</button>
    </div>
  );

  const titleOf: Record<Mode, string> = {
    out: t("Sortir du magasin", "Take out"), in: t("Arrivée au magasin", "Receive"), count: t("Corriger l'inventaire", "Correct inventory"),
    edit: t("Modifier l'article", "Edit item"), add: t("Nouvel article", "New item"),
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>{t("Magasin", "Store")}</h1>
          <p className={styles.sub}>{items.length} {t("articles", "items")}{value > 0 ? ` · ${t("valeur", "value")} ${money(value)} F` : ""}</p>
        </div>
        {canManage && <Button onClick={() => open("add", null)}>{t("+ Article", "+ Item")}</Button>}
      </div>

      {toOrder.length > 0 && (
        <section className={styles.orderCard} aria-label={t("À commander", "To order")}>
          <div className={styles.orderHead}>
            <strong>{t("À commander", "To order")} · {toOrder.length}</strong>
            <span className={styles.hint}>{t("calculé sur la consommation des 60 derniers jours", "based on the last 60 days of use")}</span>
          </div>
          {toOrder.slice(0, 6).map(({ s, st }) => (
            <div key={s.id} className={styles.orderRow}>
              <span className={styles.orderName}>{s.name}</span>
              <span className={styles.orderInfo}>
                {st.empty ? t("épuisé", "out of stock") : st.days != null ? `≈ ${st.days} ${t("j restants", "d left")}` : `${fmtQ(st.qty)} / ${t("seuil", "min")} ${fmtQ(st.min)}`}
                {st.suggest > 0 ? ` · ${t("commander", "order")} ${st.suggest} ${s.unit}` : ""}
              </span>
            </div>
          ))}
        </section>
      )}

      <div className={styles.filters}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Chercher une pièce…", "Find a part…")} />
        <div className={styles.cats}>
          {["__all", ...cats].map((c) => (
            <button key={c} type="button" className={`${styles.cat} ${cat === c ? styles.catOn : ""}`} onClick={() => setCat(c)}>{c === "__all" ? t("Tout", "All") : c}</button>
          ))}
        </div>
      </div>

      <div className={styles.items}>
        {list.map((s) => {
          const st = status(s);
          const tone = st.empty ? styles.toneCrit : st.order ? styles.toneWarn : styles.toneOk;
          return (
            <article key={s.id} className={styles.item}>
              <div className={styles.itemTop}>
                <div style={{ minWidth: 0 }}>
                  <div className={styles.itemName}>{s.name}</div>
                  <div className={styles.itemCat}>{s.category}{s.unitPrice != null ? ` · ${money(Number(s.unitPrice))} F / ${s.unit}` : ""}</div>
                </div>
                <div className={`${styles.qty} ${tone}`}>
                  <span className={styles.qtyNum}>{fmtQ(st.qty)}</span>
                  <span className={styles.qtyUnit}>{s.unit}</span>
                </div>
              </div>
              <div className={styles.itemMeta}>
                <span>{t("Seuil", "Min")} {fmtQ(st.min)}</span>
                <span>{t("Conso 30 j", "30-day use")} {fmtQ(s.used30 ?? 0)}</span>
                <span className={st.order ? styles.warnText : ""}>{st.days != null ? `≈ ${st.days} ${t("j de stock", "d of stock")}` : t("pas de conso récente", "no recent use")}</span>
              </div>
              {(canStock || canManage) && (
                <div className={styles.itemActions}>
                  {canStock && <button type="button" className={`${styles.act} ${styles.actMain}`} onClick={() => open("out", s)} disabled={st.empty}>{t("Sortir", "Take out")}</button>}
                  {canStock && <button type="button" className={styles.act} onClick={() => open("in", s)}>{t("Arrivée", "Receive")}</button>}
                  {canStock && <button type="button" className={styles.act} onClick={() => open("count", s)}>{t("Inventaire", "Count")}</button>}
                  {canManage && <button type="button" className={styles.act} onClick={() => open("edit", s)}>{t("Modifier", "Edit")}</button>}
                </div>
              )}
            </article>
          );
        })}
        {!list.length && <p className={styles.empty}>{t("Aucun article ne correspond.", "No matching item.")}</p>}
      </div>

      {recent.length > 0 && (
        <section className={styles.card}>
          <h2 className={styles.h2}>{t("Dernières sorties", "Latest take-outs")}</h2>
          {recent.map((o) => (
            <div key={o.id} className={styles.mv}>
              <span className={styles.mvMain}><strong>{o.itemName}</strong> × {fmtQ(o.quantity)} {o.unit}{o.machineNo ? ` · M/C ${String(o.machineNo).padStart(2, "0")}` : ""}</span>
              <span className={styles.mvSub}>{o.authorName ?? ""} · {new Date(o.createdAt).toLocaleDateString(fr ? "fr-FR" : "en-GB", { day: "2-digit", month: "short" })}{o.unitCost != null ? ` · ${money(o.unitCost * o.quantity)} F` : ""}</span>
            </div>
          ))}
        </section>
      )}

      <Dialog open={!!dlg} onOpenChange={(o) => { if (!o) setDlg(null); }}>
        <DialogContent className={styles.dialog}>
          <DialogHeader><DialogTitle>{dlg ? titleOf[dlg.mode] : ""}</DialogTitle></DialogHeader>
          {dlg?.item && dlg.mode !== "edit" && (
            <p className={styles.dlgSub}><strong>{dlg.item.name}</strong> · {t("en stock", "in stock")} {fmtQ(Number(dlg.item.quantity))} {dlg.item.unit}</p>
          )}
          {dlg && (dlg.mode === "out" || dlg.mode === "in" || dlg.mode === "count") && (
            <div className={styles.form}>
              <label className={styles.lbl}>{dlg.mode === "count" ? t("Quantité réelle comptée", "Actual counted quantity") : t("Quantité", "Quantity")}</label>
              {stepper}
              {dlg.mode === "out" && (
                <>
                  {openFaults.length > 0 && (
                    <>
                      <label className={styles.lbl}>{t("Pour une panne en cours (facultatif)", "For an open fault (optional)")}</label>
                      <Select value={field("fault", "__none")} onValueChange={(v) => setField("fault", v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">{t("Aucune", "None")}</SelectItem>
                          {openFaults.map((x) => <SelectItem key={x.id} value={x.id}>M/C {String(x.machineNo).padStart(2, "0")} · {x.issue}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </>
                  )}
                  {field("fault", "__none") === "__none" && (
                    <>
                      <label className={styles.lbl}>{t("Pour quelle machine", "For which machine")}</label>
                      <Select value={field("mc", "__none")} onValueChange={(v) => setField("mc", v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none">{t("Aucune machine précise", "No specific machine")}</SelectItem>
                          {state.machines.map((m) => <SelectItem key={m.no} value={String(m.no)}>M/C {String(m.no).padStart(2, "0")}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </>
                  )}
                </>
              )}
              {dlg.mode !== "count" && <Input value={field("note")} maxLength={300} onChange={(e) => setField("note", e.target.value)} placeholder={dlg.mode === "in" ? t("Fournisseur, bon de livraison… (facultatif)", "Supplier, delivery note… (optional)") : t("Remarque (facultatif)", "Remark (optional)")} />}
            </div>
          )}
          {dlg && (dlg.mode === "edit" || dlg.mode === "add") && (
            <div className={styles.form}>
              <label className={styles.lbl}>{t("Article", "Item")}</label>
              <Input value={field("name")} maxLength={120} onChange={(e) => setField("name", e.target.value)} placeholder={t("Ex. Roulement 6204", "E.g. Bearing 6204")} />
              <div className={styles.two}>
                <div><label className={styles.lbl}>{t("Catégorie", "Category")}</label><Input list="g37-store-cats" value={field("cat")} maxLength={60} onChange={(e) => setField("cat", e.target.value)} /></div>
                <div><label className={styles.lbl}>{t("Unité", "Unit")}</label><Input value={field("unit")} maxLength={20} onChange={(e) => setField("unit", e.target.value)} /></div>
              </div>
              <datalist id="g37-store-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
              {dlg.mode === "add" && (<><label className={styles.lbl}>{t("Quantité en stock", "Quantity in stock")}</label>{stepper}</>)}
              <div className={styles.two}>
                <div><label className={styles.lbl}>{t("Seuil d'alerte", "Alert threshold")}</label><Input inputMode="decimal" value={field("min")} onChange={(e) => setField("min", e.target.value)} /></div>
                <div><label className={styles.lbl}>{t("Délai de livraison (jours)", "Lead time (days)")}</label><Input inputMode="numeric" value={field("lead")} onChange={(e) => setField("lead", e.target.value)} /></div>
              </div>
              <label className={styles.lbl}>{t("Prix unitaire en F CFA (facultatif)", "Unit price in F CFA (optional)")}</label>
              <Input inputMode="decimal" value={field("price")} onChange={(e) => setField("price", e.target.value)} placeholder="0" />
              {dlg.mode === "edit" && dlg.item && (
                <button type="button" className={styles.danger} onClick={() => { if (window.confirm(t(`Supprimer « ${dlg.item!.name} » du magasin ?`, `Delete "${dlg.item!.name}" from the store?`))) { save({ action: "stockDelete", id: dlg.item!.id }); setDlg(null); } }}>
                  {t("Supprimer cet article", "Delete this item")}
                </button>
              )}
            </div>
          )}
          <div className={styles.dlgActions}>
            <Button variant="outline" onClick={() => setDlg(null)}>{t("Annuler", "Cancel")}</Button>
            <Button onClick={submit} disabled={!qtyOk}>{t("Enregistrer", "Save")}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
