import { getSupabase } from "../config/supabase.js";

/**
 * Compute start/end dates for a given period
 * period: "weekly" | "monthly"
 * Returns ISO strings for Supabase .gte/.lte filters
 */
export function getPeriodRange(period, customStart, customEnd) {
  if (customStart && customEnd) {
    return {
      start: new Date(customStart).toISOString(),
      end:   new Date(new Date(customEnd).setHours(23, 59, 59, 999)).toISOString(),
    };
  }
  const now  = new Date();
  const end  = new Date(now.setHours(23, 59, 59, 999));
  const start = new Date(end);

  if (period === "weekly") {
    start.setDate(start.getDate() - 6);          // last 7 days
  } else {
    start.setDate(1);                             // 1st of current month
    start.setHours(0, 0, 0, 0);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Generate a full inventory report for the given lab and period.
 * labId null = all labs (SUPER_ADMIN)
 */
export const generateReport = async (labId, period, customStart, customEnd) => {
  const supabase = getSupabase();
  const { start, end } = getPeriodRange(period, customStart, customEnd);

  // ── 1. STOCK SNAPSHOT ─────────────────────────────────────────
  let batchQuery = supabase
    .from("stock_batches")
    .select(`
      item_id,
      current_quantity,
      quantity_received,
      expiry_date,
      storage_location,
      items ( id, name, sku, unit_of_measure, minimum_threshold, item_type,
              categories ( name ) )
    `);
  if (labId) batchQuery = batchQuery.eq("laboratory_id", labId);
  const { data: batches, error: batchError } = await batchQuery;
  if (batchError) throw batchError;

  // Aggregate per item
  const stockMap = {};
  (batches || []).forEach(b => {
    const item = b.items;
    if (!item) return;
    if (!stockMap[b.item_id]) {
      stockMap[b.item_id] = {
        item_id:           b.item_id,
        name:              item.name,
        sku:               item.sku,
        unit_of_measure:   item.unit_of_measure,
        minimum_threshold: item.minimum_threshold,
        item_type:         item.item_type,
        category:          item.categories?.name ?? "—",
        current_stock:     0,
        batch_count:       0,
        expiring_soon:     0,   // within 30 days
        expired:           0,
      };
    }
    stockMap[b.item_id].current_stock += Number(b.current_quantity);
    stockMap[b.item_id].batch_count   += 1;

    if (b.expiry_date) {
      const days = Math.ceil(
        (new Date(b.expiry_date) - new Date()) / (1000 * 60 * 60 * 24)
      );
      if (days < 0)  stockMap[b.item_id].expired       += 1;
      else if (days <= 30) stockMap[b.item_id].expiring_soon += 1;
    }
  });

  const stockSnapshot = Object.values(stockMap).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  const lowStockItems = stockSnapshot.filter(
    i => i.current_stock < i.minimum_threshold
  );

  // ── 2. TRANSACTIONS IN PERIOD ──────────────────────────────────
  let trxQuery = supabase
    .from("stock_transactions")
    .select(`
      id,
      transaction_type,
      quantity,
      reference,
      notes,
      created_at,
      items ( name, sku, unit_of_measure, item_type,
              categories ( name ) ),
      stock_batches ( batch_number )
    `)
    .gte("created_at", start)
    .lte("created_at", end)
    .order("created_at", { ascending: false });

  if (labId) trxQuery = trxQuery.eq("laboratory_id", labId);
  const { data: transactions, error: trxError } = await trxQuery;
  if (trxError) throw trxError;

  const issued   = (transactions || []).filter(t => t.transaction_type === "ISSUE");
  const received = (transactions || []).filter(t => t.transaction_type === "RECEIVE");

  const totalIssued   = issued.reduce((s, t) => s + Number(t.quantity), 0);
  const totalReceived = received.reduce((s, t) => s + Number(t.quantity), 0);

  // Top 10 most issued items
  const issueCountMap = {};
  issued.forEach(t => {
    const key = t.items?.sku || t.item_id;
    if (!issueCountMap[key]) issueCountMap[key] = { name: t.items?.name, sku: t.items?.sku, qty: 0, count: 0 };
    issueCountMap[key].qty   += Number(t.quantity);
    issueCountMap[key].count += 1;
  });
  const topIssuedItems = Object.values(issueCountMap)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  // ── 3. EXPIRY ALERTS ───────────────────────────────────────────
  const expiryAlerts = stockSnapshot.filter(
    i => i.expiring_soon > 0 || i.expired > 0
  ).map(i => ({
    name:          i.name,
    sku:           i.sku,
    expiring_soon: i.expiring_soon,
    expired:       i.expired,
  }));

  // ── 4. CATEGORY BREAKDOWN ──────────────────────────────────────
  const catMap = {};
  stockSnapshot.forEach(i => {
    const cat = i.category;
    if (!catMap[cat]) catMap[cat] = { category: cat, total_items: 0, total_stock: 0, low_stock: 0 };
    catMap[cat].total_items += 1;
    catMap[cat].total_stock += i.current_stock;
    if (i.current_stock < i.minimum_threshold) catMap[cat].low_stock += 1;
  });
  const categoryBreakdown = Object.values(catMap).sort((a, b) =>
    a.category.localeCompare(b.category)
  );

  // ── 5. SUMMARY STATS ───────────────────────────────────────────
  const summary = {
    period,
    period_start:       start,
    period_end:         end,
    total_items:        stockSnapshot.length,
    low_stock_count:    lowStockItems.length,
    out_of_stock_count: stockSnapshot.filter(i => i.current_stock === 0).length,
    expiring_soon_count: expiryAlerts.length,
    total_transactions: (transactions || []).length,
    total_issued:       totalIssued,
    total_received:     totalReceived,
  };

  return {
    summary,
    stock_snapshot:      stockSnapshot,
    low_stock_items:     lowStockItems,
    top_issued_items:    topIssuedItems,
    transactions,
    expiry_alerts:       expiryAlerts,
    category_breakdown:  categoryBreakdown,
  };
};