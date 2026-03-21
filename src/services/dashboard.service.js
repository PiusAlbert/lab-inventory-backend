import { getSupabase } from "../config/supabase.js";

/**
 * getDashboardMetrics
 *
 * labId = null  → SUPER_ADMIN, no lab selected → aggregate across ALL labs
 * labId = uuid  → scoped to that specific lab
 */
export const getDashboardMetrics = async (labId, isAdmin = false) => {

  const supabase = getSupabase();
  const allLabs  = isAdmin && !labId;  // true = show everything unfiltered

  try {

    /**
     * Total distinct items
     */
    let batchQuery = supabase.from("stock_batches").select("item_id, laboratory_id");
    if (!allLabs) batchQuery = batchQuery.eq("laboratory_id", labId);
    const { data: labBatches, error: totalError } = await batchQuery;
    if (totalError) throw totalError;
    const totalItems = new Set(labBatches.map(b => b.item_id)).size;


    /**
     * Low stock count via RPC
     * RPC requires a lab_id — skip when showing all labs
     */
    let lowStockCount = 0;
    if (!allLabs) {
      const { data, error } = await supabase
        .rpc("low_stock_items_count", { lab_id: labId });
      if (!error) lowStockCount = data ?? 0;
    }


    /**
     * Low stock items list
     */
    let allBatchQuery = supabase.from("stock_batches").select("item_id, current_quantity");
    if (!allLabs) allBatchQuery = allBatchQuery.eq("laboratory_id", labId);
    const { data: allBatches, error: batchListError } = await allBatchQuery;
    if (batchListError) throw batchListError;

    const stockMap = {};
    (allBatches || []).forEach(b => {
      stockMap[b.item_id] = (stockMap[b.item_id] || 0) + Number(b.current_quantity);
    });

    let itemsQuery = supabase
      .from("items")
      .select("id, name, sku, minimum_threshold, unit_of_measure")
      .eq("is_active", true);
    if (!allLabs) itemsQuery = itemsQuery.eq("laboratory_id", labId);
    const { data: itemsList, error: itemsListError } = await itemsQuery;
    if (itemsListError) throw itemsListError;

    const lowStockItems = (itemsList || [])
      .filter(item => (stockMap[item.id] || 0) < Number(item.minimum_threshold))
      .map(item => ({
        id:                item.id,
        name:              item.name,
        sku:               item.sku,
        current_stock:     stockMap[item.id] || 0,
        minimum_threshold: item.minimum_threshold,
        unit_of_measure:   item.unit_of_measure,
      }))
      .slice(0, 10);

    if (allLabs) lowStockCount = lowStockItems.length;


    /**
     * Expiring batches count via RPC (lab-scoped only)
     */
    let expiringSoon = 0;
    if (!allLabs) {
      const { data, error } = await supabase
        .rpc("expiring_batches_count", { lab_id: labId });
      if (!error) expiringSoon = data ?? 0;
    }


    /**
     * Expiring batches list
     */
    const today    = new Date();
    const in30Days = new Date();
    in30Days.setDate(today.getDate() + 30);

    let expiryQuery = supabase
      .from("stock_batches")
      .select(`id, batch_number, expiry_date, current_quantity,
               items ( name, sku, unit_of_measure )`)
      .gt("current_quantity", 0)
      .lte("expiry_date", in30Days.toISOString().split("T")[0])
      .gte("expiry_date", today.toISOString().split("T")[0])
      .order("expiry_date", { ascending: true })
      .limit(10);
    if (!allLabs) expiryQuery = expiryQuery.eq("laboratory_id", labId);

    const { data: expiringBatches, error: expiringListError } = await expiryQuery;
    if (expiringListError) throw expiringListError;
    if (allLabs) expiringSoon = expiringBatches?.length ?? 0;


    /**
     * Inventory value via RPC (lab-scoped only)
     */
    let inventoryValue = 0;
    if (!allLabs) {
      const { data, error } = await supabase
        .rpc("inventory_total_value", { lab_id: labId });
      if (!error) inventoryValue = data ?? 0;
    }


    /**
     * Recent transactions — join through stock_batches for lab filter
     */
    const { data: rawTrx, error: trxError } = await supabase
      .from("stock_transactions")
      .select(`
        id, transaction_type, quantity, reference, notes, created_at,
        stock_batches (
          laboratory_id,
          batch_number,
          items ( id, name, sku, unit_of_measure )
        )
      `)
      .order("created_at", { ascending: false })
      .limit(200);

    if (trxError) throw trxError;

    const recentTransactions = (rawTrx || [])
      .filter(t => allLabs || t.stock_batches?.laboratory_id === labId)
      .slice(0, 10)
      .map(t => ({
        id:               t.id,
        transaction_type: t.transaction_type,
        quantity:         t.quantity,
        reference:        t.reference,
        notes:            t.notes,
        created_at:       t.created_at,
        items:            t.stock_batches?.items ?? null,
      }));


    /**
     * Stock by category
     */
    let catQuery = supabase
      .from("stock_batches")
      .select(`current_quantity, items ( categories ( name ) )`)
      .gt("current_quantity", 0);
    if (!allLabs) catQuery = catQuery.eq("laboratory_id", labId);

    const { data: batchData, error: catError } = await catQuery;
    if (catError) throw catError;

    const categoryMap = {};
    (batchData || []).forEach(batch => {
      const catName = batch.items?.categories?.name ?? "Uncategorised";
      categoryMap[catName] = (categoryMap[catName] || 0) + Number(batch.current_quantity);
    });

    const stock_by_category = Object.entries(categoryMap)
      .map(([category, total_quantity]) => ({ category, total_quantity }))
      .sort((a, b) => b.total_quantity - a.total_quantity);


    return {
      total_items:         totalItems      || 0,
      low_stock:           lowStockCount   || 0,
      expiring_soon:       expiringSoon    || 0,
      inventory_value:     inventoryValue  || 0,
      low_stock_items:     lowStockItems   || [],
      expiring_batches:    expiringBatches || [],
      recent_transactions: recentTransactions,
      stock_by_category,
      is_all_labs:         allLabs,
    };

  } catch (err) {
    console.error("Dashboard metrics error:", err);
    throw err;
  }
};