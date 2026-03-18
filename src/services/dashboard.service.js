import { getSupabase } from "../config/supabase.js";

export const getDashboardMetrics = async (labId) => {

  const supabase = getSupabase();

  try {

    /**
     * Total distinct items in this lab via stock_batches
     * items table has no laboratory_id — ownership lives in stock_batches
     */
    const { data: labItems, error: totalError } = await supabase
      .from("stock_batches")
      .select("item_id")
      .eq("laboratory_id", labId);

    if (totalError) throw totalError;

    const totalItems = new Set(labItems.map(b => b.item_id)).size;


    /**
     * Low stock count via RPC
     */
    const { data: lowStockCount, error: lowStockError } = await supabase
      .rpc("low_stock_items_count", { lab_id: labId });

    if (lowStockError) throw lowStockError;


    /**
     * Low stock items list — actionable rows for the alert panel
     */
    const { data: allBatches, error: batchListError } = await supabase
      .from("stock_batches")
      .select("item_id, current_quantity")
      .eq("laboratory_id", labId);

    if (batchListError) throw batchListError;

    const stockMap = {};
    allBatches.forEach(b => {
      stockMap[b.item_id] = (stockMap[b.item_id] || 0) + Number(b.current_quantity);
    });

    const { data: itemsList, error: itemsListError } = await supabase
      .from("items")
      .select("id, name, sku, minimum_threshold, unit_of_measure")
      .eq("laboratory_id", labId)
      .eq("is_active", true);

    if (itemsListError) throw itemsListError;

    const lowStockItems = (itemsList || [])
      .filter(item => (stockMap[item.id] || 0) < Number(item.minimum_threshold))
      .map(item => ({
        id:                item.id,
        name:              item.name,
        sku:               item.sku,
        current_stock:     stockMap[item.id] || 0,
        minimum_threshold: item.minimum_threshold,
        unit_of_measure:   item.unit_of_measure
      }))
      .slice(0, 10);


    /**
     * Expiring batches count via RPC
     */
    const { data: expiringSoon, error: expiryError } = await supabase
      .rpc("expiring_batches_count", { lab_id: labId });

    if (expiryError) throw expiryError;


    /**
     * Expiring batches list — batches expiring within 30 days
     */
    const today    = new Date();
    const in30Days = new Date();
    in30Days.setDate(today.getDate() + 30);

    const { data: expiringBatches, error: expiringListError } = await supabase
      .from("stock_batches")
      .select(`
        id, batch_number, expiry_date, current_quantity,
        items ( name, sku, unit_of_measure )
      `)
      .eq("laboratory_id", labId)
      .gt("current_quantity", 0)
      .lte("expiry_date", in30Days.toISOString().split("T")[0])
      .gte("expiry_date", today.toISOString().split("T")[0])
      .order("expiry_date", { ascending: true })
      .limit(10);

    if (expiringListError) throw expiringListError;


    /**
     * Inventory value via RPC
     */
    const { data: inventoryValue, error: valueError } = await supabase
      .rpc("inventory_total_value", { lab_id: labId });

    if (valueError) throw valueError;


    /**
     * Recent transactions — last 10
     */
    const { data: recentTransactions, error: trxError } = await supabase
      .from("stock_transactions")
      .select(`
        id, transaction_type, quantity, reference, created_at,
        items ( name, sku, unit_of_measure )
      `)
      .eq("laboratory_id", labId)
      .order("created_at", { ascending: false })
      .limit(10);

    if (trxError) throw trxError;


    /**
     * Stock by category for bar chart
     */
    const { data: batchData, error: catError } = await supabase
      .from("stock_batches")
      .select(`current_quantity, items ( categories ( name ) )`)
      .eq("laboratory_id", labId)
      .gt("current_quantity", 0);

    if (catError) throw catError;

    const categoryMap = {};
    batchData.forEach(batch => {
      const catName = batch.items?.categories?.name ?? "Uncategorised";
      categoryMap[catName] =
        (categoryMap[catName] || 0) + Number(batch.current_quantity);
    });

    const stock_by_category = Object.entries(categoryMap)
      .map(([category, total_quantity]) => ({ category, total_quantity }))
      .sort((a, b) => b.total_quantity - a.total_quantity);


    return {
      total_items:         totalItems         || 0,
      low_stock:           lowStockCount      || 0,
      expiring_soon:       expiringSoon       || 0,
      inventory_value:     inventoryValue     || 0,
      low_stock_items:     lowStockItems      || [],
      expiring_batches:    expiringBatches    || [],
      recent_transactions: recentTransactions || [],
      stock_by_category
    };

  } catch (err) {
    console.error("Dashboard metrics error:", err);
    throw err;
  }

};