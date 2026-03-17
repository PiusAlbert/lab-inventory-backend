import { getSupabase } from "../config/supabase.js";

export const getDashboardMetrics = async (labId) => {

  /**
   * getSupabase() called inside the function — safe from ESM hoisting
   */
  const supabase = getSupabase();

  try {

    /**
     * Total active items for this lab
     * NOTE: items table has no laboratory_id — scoped via stock_batches
     * We count distinct items that have at least one batch in this lab
     */
    const { data: labItems, error: totalError } = await supabase
      .from("stock_batches")
      .select("item_id")
      .eq("laboratory_id", labId);

    if (totalError) throw totalError;

    const totalItems = new Set(labItems.map(b => b.item_id)).size;


    /**
     * Low stock items
     */
    const { data: lowStockData, error: lowStockError } = await supabase
      .rpc("low_stock_items_count", { lab_id: labId });

    if (lowStockError) throw lowStockError;


    /**
     * Expiring batches
     */
    const { data: expiringSoon, error: expiryError } = await supabase
      .rpc("expiring_batches_count", { lab_id: labId });

    if (expiryError) throw expiryError;


    /**
     * Inventory value
     */
    const { data: inventoryValue, error: valueError } = await supabase
      .rpc("inventory_total_value", { lab_id: labId });

    if (valueError) throw valueError;


    /**
     * Recent transactions
     */
    const { data: recentTransactions, error: trxError } = await supabase
      .from("stock_transactions")
      .select(`
        *,
        stock_batches (
          items ( name, sku )
        )
      `)
      .eq("laboratory_id", labId)
      .order("created_at", { ascending: false })
      .limit(10);

    if (trxError) throw trxError;


    /**
     * Stock quantity by category — scoped to this lab
     *
     * Joins stock_batches (lab-scoped) → items → categories
     * Aggregates current_quantity per category name in JS.
     * No schema changes needed — uses existing relationships.
     */
    const { data: batchData, error: catError } = await supabase
      .from("stock_batches")
      .select(`
        current_quantity,
        items (
          categories ( name )
        )
      `)
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
      total_items: totalItems || 0,
      low_stock: lowStockData || 0,
      expiring_soon: expiringSoon || 0,
      inventory_value: inventoryValue || 0,
      recent_transactions: recentTransactions || [],
      stock_by_category
    };

  } catch (err) {
    console.error("Dashboard metrics error:", err);
    throw err;
  }

};