import React, { useMemo, useState } from "react";
import type { OutputType as State, G37StockItem } from "../endpoints/g37/state_GET.schema";
import type { InputType } from "../endpoints/g37/mutate_POST.schema";
import { g37 } from "../helpers/g37";
import { Button } from "./Button";
import { Input } from "./Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./Select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./Dialog";
import styles from "./StoreView.module.css";

// Magasin : stock présenté comme un tableau Excel (en-têtes figés, colonnes N° et Désignation figées,
// quadrillage, tri par colonne, bandes par catégorie), sorties par machine (et par panne), arrivées,
// inventaire, prix, et alerte de réapprovisionnement calculée sur la consommation réelle.

type Mode = "view" | "out" | "in" | "count" | "edit" | "add";
type SortKey = "cat" | "name" | "code" | "qty" | "min" | "state" | "order" | "use" | "price";
type Filter = "all" | "order" | "empty";

const num = (v: string) => { const n = Number(v.replace(",", ".").trim()); return Number.isFinite(n) ? n : NaN; };
const money = (v: number) => Math.round(v).toLocaleString("fr-FR").replace(/ | /g, " ");
const fmtQ = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "").replace(".", ","));
const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

function status(s: G37StockItem) {
  const qty = Number(s.quantity);
  const min = Number(s.minimumQuantity || g37.STOCK_ALERT);
  const lead = s.leadDays ?? 14;
  const days = s.daysLeft ?? null;
  const perDay = s.perDay ?? 0;
  const order = qty < min || (days != null && days <= lead);
  // Quantité conseillée : couvrir le délai + 30 jours de consommation, au-dessus du seuil.
  const suggest = Math.max(0, Math.ceil(perDay * (lead + 30) + min - qty));
  const empty = qty <= 0;
  return { qty, min, lead, days, order: order || empty, suggest, empty, rank: empty ? 0 : order ? 1 : 2 };
}

export function StoreView({ state, lang, save, canStock, canManage }: {
  state: State; lang: "fr" | "en"; save: (input: InputType) => void; canStock: boolean; canManage: boolean;
}) {
  const fr = lang === "fr";
  const t = (a: string, b: string) => (fr ? a : b);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("__all");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "cat", dir: 1 });
  const [dlg, setDlg] = useState<{ mode: Mode; item: G37StockItem | null } | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const field = (k: string, def = "") => f[k] ?? def;
  const setField = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const items = state.stock ?? [];
  const cats = useMemo(() => Array.from(new Set(items.map((s) => s.category))).sort(collator.compare), [items]);
  const rows = useMemo(() => items.map((s) => ({ s, st: status(s) })), [items]);
  const nOrder = rows.filter((r) => r.st.order).length;
  const nEmpty = rows.filter((r) => r.st.empty).length;
  const value = items.reduce((a, s) => a + (s.unitPrice != null ? Number(s.unitPrice) * Number(s.quantity) : 0), 0);
  const recent = (state.stockOuts ?? []).slice(0, 8);
  const openFaults = (state.failures ?? []).filter((x) => x.status !== "resolue");

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = rows.filter(({ s, st }) =>
      (cat === "__all" || s.category === cat)
      && (filter === "all" || (filter === "order" ? st.order : st.empty))
      && (!needle || `${s.name} ${s.code ?? ""} ${s.category} ${s.note ?? ""}`.toLowerCase().includes(needle)));
    const by = (a: typeof out[number], b: typeof out[number]): number => {
      switch (sort.key) {
        case "name": return collator.compare(a.s.name, b.s.name);
        case "code": return collator.compare(a.s.code || "~", b.s.code || "~");
        case "qty": return a.st.qty - b.st.qty;
        case "min": return a.st.min - b.st.min;
        case "state": return a.st.rank - b.st.rank;
        case "order": return a.st.suggest - b.st.suggest;
        case "use": return (a.s.used30 ?? 0) - (b.s.used30 ?? 0);
        case "price": return Number(a.s.unitPrice ?? -1) - Number(b.s.unitPrice ?? -1);
        default: return 0;
      }
    };
    return out.sort((a, b) => {
      if (sort.key === "cat") return sort.dir * collator.compare(a.s.category, b.s.category) || collator.compare(a.s.name, b.s.name);
      return sort.dir * by(a, b) || collator.compare(a.s.name, b.s.name);
    });
  }, [rows, q, cat, filter, sort]);

  const sortBy = (key: SortKey) => setSort((p) => (p.key === key ? { key, dir: p.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  const open = (mode: Mode, item: G37StockItem | null) => {
    setF(item ? {
      qty: mode === "count" ? String(Number(item.quantity)) : "1", name: item.name, cat: item.category, unit: item.unit,
      min: String(Number(item.minimumQuantity || g37.STOCK_ALERT)), price: item.unitPrice ?? "", lead: String(item.leadDays ?? 14), mc: "__none", fault: "__none", note: "",
      code: item.code ?? "", remark: item.note ?? "",
    } : { qty: "0", name: "", cat: cat === "__all" ? "" : cat, unit: "pcs", min: String(g37.STOCK_ALERT), price: "", lead: "14", code: "", remark: "" });
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
        code: field("code").trim() || null, note: field("remark").trim() || null,
      });
    } else if (dlg.mode === "add") {
      const price = field("price").trim() === "" ? null : num(field("price"));
      save({
        action: "stockAdd", name: field("name").trim(), category: field("cat").trim(), unit: field("unit").trim() || "pcs",
        quantity: Math.max(0, num(field("qty")) || 0), minimumQuantity: Math.max(0, num(field("min")) || 0),
        unitPrice: price != null && price >= 0 ? price : null, leadDays: Math.min(365, Math.max(1, Math.round(num(field("lead")) || 14))),
        code: field("code").trim() || null, note: field("remark").trim() || null,
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
    view: t("Article", "Item"), out: t("Sortir du magasin", "Take out"), in: t("Arrivée au magasin", "Receive"), count: t("Corriger l'inventaire", "Correct inventory"),
    edit: t("Modifier l'article", "Edit item"), add: t("Nouvel article", "New item"),
  };

  const stateCell = (st: ReturnType<typeof status>) => (
    <span className={`${styles.pill} ${st.empty ? styles.pillCrit : st.order ? styles.pillWarn : styles.pillOk}`}>
      {st.empty ? t("Rupture", "Out") : st.order ? t("À commander", "To order") : "OK"}
    </span>
  );

  // Colonnes du tableau (les deux premières restent figées pendant le défilement horizontal).
  const head: { key: SortKey | null; label: string; cls?: string }[] = [
    { key: null, label: "N°", cls: `${styles.cNo} ${styles.fz0}` },
    { key: "name", label: t("Désignation", "Description"), cls: `${styles.cName} ${styles.fz1}` },
    { key: "qty", label: t("Qté", "Qty"), cls: styles.cQty },
    { key: "code", label: "Code", cls: styles.cCode },
    { key: "state", label: t("État", "Status"), cls: styles.cState },
    { key: null, label: t("Unité", "Unit"), cls: styles.cUnit },
    { key: "min", label: t("Seuil", "Min"), cls: styles.cNum },
    { key: "order", label: t("À cmd.", "Order"), cls: styles.cNum },
    { key: "use", label: t("Conso 30 j", "30-day use"), cls: styles.cUse },
    { key: "price", label: t("Prix U. (F)", "Unit price"), cls: styles.cPrice },
    { key: "cat", label: t("Catégorie", "Category"), cls: styles.cCat },
    { key: null, label: t("Remarque", "Remark"), cls: styles.cNote },
  ];
  const showBands = sort.key === "cat" && cat === "__all";
  const catCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of list) m.set(r.s.category, (m.get(r.s.category) ?? 0) + 1);
    return m;
  }, [list]);

  const body: React.ReactNode[] = [];
  let lastCat = "";
  list.forEach(({ s, st }, i) => {
    if (showBands && s.category !== lastCat) {
      lastCat = s.category;
      body.push(
        <tr key={`band-${s.category}`} className={styles.band}>
          <td colSpan={head.length}><span className={styles.bandLabel}>{s.category} <em>· {catCount.get(s.category) ?? 0} {(catCount.get(s.category) ?? 0) > 1 ? t("articles", "items") : t("article", "item")}</em></span></td>
        </tr>,
      );
    }
    body.push(
      <tr key={s.id} className={`${styles.row} ${i % 2 ? styles.alt : ""}`} tabIndex={0}
        onClick={() => open("view", s)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open("view", s); } }}>
        <td className={`${styles.cNo} ${styles.fz0}`}>{i + 1}</td>
        <td className={`${styles.cName} ${styles.fz1}`}>{s.name}</td>
        <td className={`${styles.cQty} ${st.empty ? styles.tCrit : st.order ? styles.tWarn : ""}`}>{fmtQ(st.qty)}</td>
        <td className={styles.cCode}>{s.code || <span className={styles.nil}>—</span>}</td>
        <td className={styles.cState}>{stateCell(st)}</td>
        <td className={styles.cUnit}>{s.unit}</td>
        <td className={styles.cNum}>{fmtQ(st.min)}</td>
        <td className={styles.cNum}>{st.order && st.suggest > 0 ? st.suggest : <span className={styles.nil}>—</span>}</td>
        <td className={styles.cUse}>{fmtQ(s.used30 ?? 0)}</td>
        <td className={styles.cPrice}>{s.unitPrice != null ? money(Number(s.unitPrice)) : <span className={styles.nil}>—</span>}</td>
        <td className={styles.cCat}>{s.category}</td>
        <td className={styles.cNote}>{s.note || ""}</td>
      </tr>,
    );
  });

  const it = dlg?.item ?? null;
  const itSt = it ? status(it) : null;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>{t("Magasin", "Store")}</h1>
          <p className={styles.sub}>{items.length} {t("articles", "items")}{value > 0 ? ` · ${t("valeur", "value")} ${money(value)} F` : ""}</p>
        </div>
        {canManage && <Button onClick={() => open("add", null)}>{t("+ Article", "+ Item")}</Button>}
      </div>

      <div className={styles.tiles} role="group" aria-label={t("Filtrer par état", "Filter by status")}>
        <button type="button" className={`${styles.tile} ${filter === "all" ? styles.tileOn : ""}`} onClick={() => setFilter("all")}>
          <span className={styles.tileNum}>{items.length}</span><span className={styles.tileLbl}>{t("Articles", "Items")}</span>
        </button>
        <button type="button" className={`${styles.tile} ${styles.tileWarn} ${filter === "order" ? styles.tileOn : ""}`} onClick={() => setFilter(filter === "order" ? "all" : "order")}>
          <span className={styles.tileNum}>{nOrder}</span><span className={styles.tileLbl}>{t("À commander", "To order")}</span>
        </button>
        <button type="button" className={`${styles.tile} ${styles.tileCrit} ${filter === "empty" ? styles.tileOn : ""}`} onClick={() => setFilter(filter === "empty" ? "all" : "empty")}>
          <span className={styles.tileNum}>{nEmpty}</span><span className={styles.tileLbl}>{t("En rupture", "Out of stock")}</span>
        </button>
      </div>

      <div className={styles.filters}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Chercher une pièce, un code…", "Find a part, a code…")} />
        <div className={styles.cats}>
          {["__all", ...cats].map((c) => (
            <button key={c} type="button" className={`${styles.cat} ${cat === c ? styles.catOn : ""}`} onClick={() => setCat(c)}>{c === "__all" ? t("Tout", "All") : c}</button>
          ))}
        </div>
      </div>

      <div className={styles.sheetWrap}>
        <div className={styles.sheet} role="region" aria-label={t("Tableau du magasin", "Store table")} tabIndex={0}>
          <table className={styles.table}>
            <thead>
              <tr>
                {head.map((h, k) => (
                  <th key={k} scope="col" className={h.cls} aria-sort={h.key && sort.key === h.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                    {h.key ? <button type="button" className={styles.thBtn} onClick={() => sortBy(h.key!)}>{h.label}{arrow(h.key)}</button> : h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{body}</tbody>
          </table>
          {!list.length && <p className={styles.empty}>{t("Aucun article ne correspond.", "No matching item.")}</p>}
        </div>
        <div className={styles.sheetFoot}>
          <span>{list.length} / {items.length} {t("lignes", "rows")}</span>
          <span className={styles.hint}>{t("Touchez une ligne pour sortir, recevoir ou corriger · touchez un titre pour trier", "Tap a row to act · tap a header to sort")}</span>
        </div>
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
          <DialogHeader><DialogTitle>{dlg ? (dlg.mode === "view" && it ? it.name : titleOf[dlg.mode]) : ""}</DialogTitle></DialogHeader>

          {dlg?.mode === "view" && it && itSt && (
            <>
              <dl className={styles.facts}>
                <div><dt>Code</dt><dd className={styles.mono}>{it.code || "—"}</dd></div>
                <div><dt>{t("Catégorie", "Category")}</dt><dd>{it.category}</dd></div>
                <div><dt>{t("En stock", "In stock")}</dt><dd className={`${styles.mono} ${itSt.empty ? styles.tCrit : itSt.order ? styles.tWarn : ""}`}>{fmtQ(itSt.qty)} {it.unit}</dd></div>
                <div><dt>{t("Seuil", "Min")}</dt><dd className={styles.mono}>{fmtQ(itSt.min)}</dd></div>
                <div><dt>{t("État", "Status")}</dt><dd>{stateCell(itSt)}</dd></div>
                <div><dt>{t("Conso 30 j", "30-day use")}</dt><dd className={styles.mono}>{fmtQ(it.used30 ?? 0)}{itSt.days != null ? ` · ≈ ${itSt.days} ${t("j", "d")}` : ""}</dd></div>
                {itSt.order && itSt.suggest > 0 && <div><dt>{t("À commander", "To order")}</dt><dd className={styles.mono}>{itSt.suggest} {it.unit}</dd></div>}
                {it.unitPrice != null && <div><dt>{t("Prix unitaire", "Unit price")}</dt><dd className={styles.mono}>{money(Number(it.unitPrice))} F</dd></div>}
                {it.note && <div className={styles.factWide}><dt>{t("Remarque", "Remark")}</dt><dd>{it.note}</dd></div>}
              </dl>
              {(canStock || canManage) ? (
                <div className={styles.viewActions}>
                  {canStock && <button type="button" className={`${styles.act} ${styles.actMain}`} onClick={() => open("out", it)} disabled={itSt.empty}>{t("Sortir", "Take out")}</button>}
                  {canStock && <button type="button" className={styles.act} onClick={() => open("in", it)}>{t("Arrivée", "Receive")}</button>}
                  {canStock && <button type="button" className={styles.act} onClick={() => open("count", it)}>{t("Inventaire", "Count")}</button>}
                  {canManage && <button type="button" className={styles.act} onClick={() => open("edit", it)}>{t("Modifier", "Edit")}</button>}
                </div>
              ) : null}
              <div className={styles.dlgActions}>
                <Button variant="outline" onClick={() => setDlg(null)}>{t("Fermer", "Close")}</Button>
              </div>
            </>
          )}

          {dlg && dlg.mode !== "view" && it && dlg.mode !== "edit" && (
            <p className={styles.dlgSub}><strong>{it.name}</strong>{it.code ? ` · ${it.code}` : ""} · {t("en stock", "in stock")} {fmtQ(Number(it.quantity))} {it.unit}</p>
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
              <label className={styles.lbl}>{t("Désignation", "Description")}</label>
              <Input value={field("name")} maxLength={120} onChange={(e) => setField("name", e.target.value)} placeholder={t("Ex. Roulement 6204", "E.g. Bearing 6204")} />
              <div className={styles.two}>
                <div><label className={styles.lbl}>Code</label><Input value={field("code")} maxLength={40} onChange={(e) => setField("code", e.target.value)} placeholder={t("Ex. 826906201", "E.g. 826906201")} /></div>
                <div><label className={styles.lbl}>{t("Unité", "Unit")}</label><Input value={field("unit")} maxLength={20} onChange={(e) => setField("unit", e.target.value)} /></div>
              </div>
              <label className={styles.lbl}>{t("Catégorie", "Category")}</label>
              <Input list="g37-store-cats" value={field("cat")} maxLength={60} onChange={(e) => setField("cat", e.target.value)} />
              <datalist id="g37-store-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
              {dlg.mode === "add" && (<><label className={styles.lbl}>{t("Quantité en stock", "Quantity in stock")}</label>{stepper}</>)}
              <div className={styles.two}>
                <div><label className={styles.lbl}>{t("Seuil d'alerte", "Alert threshold")}</label><Input inputMode="decimal" value={field("min")} onChange={(e) => setField("min", e.target.value)} /></div>
                <div><label className={styles.lbl}>{t("Délai de livraison (jours)", "Lead time (days)")}</label><Input inputMode="numeric" value={field("lead")} onChange={(e) => setField("lead", e.target.value)} /></div>
              </div>
              <label className={styles.lbl}>{t("Prix unitaire en F CFA (facultatif)", "Unit price in F CFA (optional)")}</label>
              <Input inputMode="decimal" value={field("price")} onChange={(e) => setField("price", e.target.value)} placeholder="0" />
              <label className={styles.lbl}>{t("Remarque (facultatif)", "Remark (optional)")}</label>
              <Input value={field("remark")} maxLength={300} onChange={(e) => setField("remark", e.target.value)} />
              {dlg.mode === "edit" && it && (
                <button type="button" className={styles.danger} onClick={() => { if (window.confirm(t(`Supprimer « ${it.name} » du magasin ?`, `Delete "${it.name}" from the store?`))) { save({ action: "stockDelete", id: it.id }); setDlg(null); } }}>
                  {t("Supprimer cet article", "Delete this item")}
                </button>
              )}
            </div>
          )}
          {dlg && dlg.mode !== "view" && (
            <div className={styles.dlgActions}>
              <Button variant="outline" onClick={() => setDlg(null)}>{t("Annuler", "Cancel")}</Button>
              <Button onClick={submit} disabled={!qtyOk}>{t("Enregistrer", "Save")}</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
