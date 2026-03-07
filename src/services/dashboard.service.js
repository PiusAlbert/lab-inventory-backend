import { supabase } from '../config/supabase.js'

export const getDashboardMetrics = async (labId) => {

  const { count: totalItems } = await supabase
    .from('items')
    .select('*', { count: 'exact', head: true })
    .eq('laboratory_id', labId)
    .eq('is_active', true)


  const { data: lowStockData } = await supabase
    .rpc('low_stock_items_count', { lab_id: labId })


  const { data: expiringSoon } = await supabase
    .rpc('expiring_batches_count', { lab_id: labId })


  const { data: inventoryValue } = await supabase
    .rpc('inventory_total_value', { lab_id: labId })


  const { data: recentTransactions } = await supabase
    .from('stock_transactions')
    .select(`
      *,
      items(name, sku)
    `)
    .eq('laboratory_id', labId)
    .order('created_at', { ascending: false })
    .limit(10)

  return {
    total_items: totalItems || 0,
    low_stock: lowStockData || 0,
    expiring_soon: expiringSoon || 0,
    inventory_value: inventoryValue || 0,
    recent_transactions: recentTransactions || []
  }
}