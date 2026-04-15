import { getSupabase } from "../config/supabase.js";
import { v4 as uuidv4 } from "uuid";

async function writeAuditLog({
  userId,
  action,
  entity,
  entityId,
  oldData = null,
  newData = null,
}) {
  const supabase = getSupabase();

  const { error } = await supabase.from("audit_logs").insert({
    id: uuidv4(),
    user_id: userId,
    action,
    table_affected: entity,
    record_id: entityId,
    created_at: new Date(),
    details: { old_data: oldData, new_data: newData },
  });

  if (error) console.error("Audit log error:", error);
}

function cleanObject(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined)
  );
}

function normalizeItemPayload(body = {}) {
  return {
    category_id: body.category_id,
    supplier_id: body.supplier_id ?? null,
    name: body.name,
    sku: body.sku,
    barcode: body.barcode ?? null,
    unit_of_measure: body.unit_of_measure,
    dispensing_unit: body.dispensing_unit ?? null,
    conversion_factor:
      body.conversion_factor === "" || body.conversion_factor == null
        ? null
        : Number(body.conversion_factor),
    minimum_threshold:
      body.minimum_threshold === "" || body.minimum_threshold == null
        ? 0
        : Number(body.minimum_threshold),
    reorder_quantity:
      body.reorder_quantity === "" || body.reorder_quantity == null
        ? null
        : Number(body.reorder_quantity),
    max_stock_level:
      body.max_stock_level === "" || body.max_stock_level == null
        ? null
        : Number(body.max_stock_level),
    hazard_class: body.hazard_class ?? null,
    storage_condition: body.storage_condition ?? null,
    regulatory_notes: body.regulatory_notes ?? null,
    is_perishable: Boolean(body.is_perishable),
    item_type: body.item_type,
    unit_price:
      body.unit_price === "" || body.unit_price == null
        ? null
        : Number(body.unit_price),
  };
}

function normalizeExtensionData(itemType, data = {}) {
  if (!data || typeof data !== "object") return {};

  if (itemType === "CHEMICAL") {
    return cleanObject({
      formula: data.formula ?? null,
      cas_number: data.cas_number ?? null,
      molecular_weight:
        data.molecular_weight === "" || data.molecular_weight == null
          ? null
          : Number(data.molecular_weight),
      msds_url: data.msds_url ?? null,
      pubchem_id:
        data.pubchem_id === "" || data.pubchem_id == null
          ? null
          : Number(data.pubchem_id),
      ghp_classification: data.ghp_classification ?? null,
    });
  }

  if (itemType === "EQUIPMENT") {
    return cleanObject({
      model_number: data.model_number ?? null,
      serial_number: data.serial_number ?? null,
      maintenance_interval_days:
        data.maintenance_interval_days === "" || data.maintenance_interval_days == null
          ? null
          : Number(data.maintenance_interval_days),
      last_maintenance_date: data.last_maintenance_date ?? null,
      warranty_expiry: data.warranty_expiry ?? null,
    });
  }

  if (itemType === "CRM") {
    return cleanObject({
      certification_number: data.certification_number ?? null,
      certification_expiry: data.certification_expiry ?? null,
      issuing_body: data.issuing_body ?? null,
    });
  }

  return {};
}

async function insertExtensionTable(itemType, itemId, data = {}) {
  const supabase = getSupabase();

  const tableMap = {
    CHEMICAL: "item_chemical_details",
    EQUIPMENT: "item_equipment_details",
    CRM: "item_reference_details",
  };

  const tableName = tableMap[itemType];
  if (!tableName) return;

  const normalized = normalizeExtensionData(itemType, data);

  const { error } = await supabase.from(tableName).insert({
    item_id: itemId,
    ...normalized,
  });

  if (error) throw error;
}

async function upsertExtensionTable(itemType, itemId, data = {}) {
  const supabase = getSupabase();

  const tableMap = {
    CHEMICAL: "item_chemical_details",
    EQUIPMENT: "item_equipment_details",
    CRM: "item_reference_details",
  };

  const tableName = tableMap[itemType];
  if (!tableName) return;

  const normalized = normalizeExtensionData(itemType, data);

  const { error } = await supabase
    .from(tableName)
    .upsert({ item_id: itemId, ...normalized }, { onConflict: "item_id" });

  if (error) throw error;
}

async function deleteOtherExtensionRows(itemType, itemId) {
  const supabase = getSupabase();

  const tableMap = {
    CHEMICAL: "item_chemical_details",
    EQUIPMENT: "item_equipment_details",
    CRM: "item_reference_details",
  };

  const tablesToDelete = Object.entries(tableMap)
    .filter(([type]) => type !== itemType)
    .map(([, tableName]) => tableName);

  for (const tableName of tablesToDelete) {
    const { error } = await supabase.from(tableName).delete().eq("item_id", itemId);
    if (error) throw error;
  }
}

async function fetchSingleItemWithJoins(id, labId = null) {
  const supabase = getSupabase();

  let query = supabase
    .from("items")
    .select(`
      *,
      categories ( name ),
      suppliers  ( name ),
      item_chemical_details (
        formula,
        cas_number,
        molecular_weight,
        msds_url,
        pubchem_id,
        ghp_classification
      ),
      item_equipment_details (
        model_number,
        serial_number,
        maintenance_interval_days,
        last_maintenance_date,
        warranty_expiry
      ),
      item_reference_details (
        certification_number,
        certification_expiry,
        issuing_body
      )
    `)
    .eq("id", id);

  if (labId) query = query.eq("laboratory_id", labId);

  const { data, error } = await query.single();
  if (error || !data) {
    throw new Error("Item not found");
  }

  return data;
}

export const getItems = async (req, res) => {
  const supabase = getSupabase();
  const labId = req.user.laboratory_id ?? null;

  try {
    let query = supabase
      .from("items")
      .select(`*, categories(name), suppliers(name)`)
      .order("created_at", { ascending: false });

    if (labId) query = query.eq("laboratory_id", labId);

    const { data, error } = await query;
    if (error) throw error;

    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

export const searchItems = async (req, res) => {
  const supabase = getSupabase();
  const labId = req.user.laboratory_id ?? null;
  const {
    search = "",
    category,
    low_stock,
    page = 1,
    limit = 20,
    sort = "created_at",
  } = req.query;

  const offset = (page - 1) * limit;

  try {
    let query = supabase
      .from("items")
      .select(`*, categories(name), suppliers(name)`, { count: "exact" });

    if (labId) query = query.eq("laboratory_id", labId);
    if (search) query = query.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
    if (category) query = query.eq("category_id", category);

    query = query
      .order(sort, { ascending: true })
      .range(offset, offset + Number(limit) - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    let filteredData = data;

    if (low_stock === "true") {
      let bq = supabase.from("stock_batches").select("item_id, current_quantity");
      if (labId) bq = bq.eq("laboratory_id", labId);

      const { data: batches } = await bq;
      const stockMap = {};

      (batches || []).forEach((b) => {
        stockMap[b.item_id] = (stockMap[b.item_id] || 0) + Number(b.current_quantity || 0);
      });

      filteredData = data.filter(
        (i) => (stockMap[i.id] || 0) < Number(i.minimum_threshold || 0)
      );
    }

    return res.json({
      data: filteredData,
      pagination: {
        total: count,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(count / limit),
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/items/:id
 *
 * Explicitly joins all three extension tables.
 * PostgREST needs these in the select string so it can resolve the FK
 * relationships without ambiguity.
 */
export const getItemById = async (req, res) => {
  const labId = req.user.laboratory_id ?? null;
  const { id } = req.params;

  try {
    const item = await fetchSingleItemWithJoins(id, labId);
    return res.json(item);
  } catch (err) {
    return res.status(404).json({ error: "Item not found" });
  }
};

export const createItem = async (req, res) => {
  const supabase = getSupabase();
  const labId = req.user.laboratory_id;
  const userId = req.user.id;

  if (!labId) {
    return res.status(400).json({
      error: "Please select a laboratory before adding items",
    });
  }

  const { extension_data = {}, ...rawItemFields } = req.body;
  const itemFields = normalizeItemPayload(rawItemFields);
  const {
    category_id,
    name,
    sku,
    unit_of_measure,
    item_type,
    hazard_class,
    dispensing_unit,
    conversion_factor,
  } = itemFields;

  try {
    if (!name?.trim()) return res.status(400).json({ error: "Name is required" });
    if (!sku?.trim()) return res.status(400).json({ error: "SKU is required" });
    if (!item_type) return res.status(400).json({ error: "Item type is required" });
    if (!category_id) return res.status(400).json({ error: "Category is required" });
    if (!unit_of_measure) {
      return res.status(400).json({ error: "Unit of measure is required" });
    }

    const { data: category, error: categoryError } = await supabase
      .from("categories")
      .select("id")
      .eq("id", category_id)
      .single();

    if (categoryError || !category) {
      return res.status(400).json({ error: "Invalid category" });
    }

    if (item_type === "CHEMICAL" && !hazard_class) {
      return res.status(400).json({ error: "Hazard class required for chemical items" });
    }

    if (
      dispensing_unit &&
      (conversion_factor == null || Number.isNaN(Number(conversion_factor)) || Number(conversion_factor) <= 0)
    ) {
      return res.status(400).json({
        error: "Conversion factor must be greater than 0 when dispensing unit is set",
      });
    }

    if (item_type === "EQUIPMENT" && !extension_data?.maintenance_interval_days) {
      return res.status(400).json({
        error: "Maintenance interval required for equipment",
      });
    }

    if (item_type === "CRM" && !extension_data?.certification_expiry) {
      return res.status(400).json({
        error: "Certification expiry required for CRM",
      });
    }

    const { data: existing, error: existingError } = await supabase
      .from("items")
      .select("id")
      .eq("laboratory_id", labId)
      .eq("sku", sku)
      .maybeSingle();

    if (existingError) throw existingError;
    if (existing) {
      return res.status(400).json({ error: "SKU already exists in this laboratory" });
    }

    const itemId = uuidv4();

    const { error: itemError } = await supabase.from("items").insert({
      id: itemId,
      laboratory_id: labId,
      ...itemFields,
    });

    if (itemError) throw itemError;

    await insertExtensionTable(item_type, itemId, extension_data);

    await writeAuditLog({
      userId,
      action: "CREATE",
      entity: "items",
      entityId: itemId,
      newData: req.body,
    });

    const item = await fetchSingleItemWithJoins(itemId, labId);
    return res.status(201).json(item);
  } catch (err) {
    console.error("createItem error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const updateItem = async (req, res) => {
  const supabase = getSupabase();
  const labId = req.user.laboratory_id ?? null;
  const userId = req.user.id;
  const { id } = req.params;

  const { extension_data = {}, ...rawItemFields } = req.body;
  const cleanedRawItemFields = cleanObject(rawItemFields);

  try {
    let existingQuery = supabase.from("items").select("*").eq("id", id);
    if (labId) existingQuery = existingQuery.eq("laboratory_id", labId);

    const { data: existingItem, error: existingErr } = await existingQuery.single();

    if (existingErr || !existingItem) {
      return res.status(404).json({ error: "Item not found" });
    }

    const mergedItemFields = normalizeItemPayload({
      ...existingItem,
      ...cleanedRawItemFields,
    });

    const itemType = mergedItemFields.item_type || existingItem.item_type;

    if (!mergedItemFields.name?.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    if (!mergedItemFields.sku?.trim()) {
      return res.status(400).json({ error: "SKU is required" });
    }

    if (!mergedItemFields.category_id) {
      return res.status(400).json({ error: "Category is required" });
    }

    if (!mergedItemFields.unit_of_measure) {
      return res.status(400).json({ error: "Unit of measure is required" });
    }

    const { data: category, error: categoryError } = await supabase
      .from("categories")
      .select("id")
      .eq("id", mergedItemFields.category_id)
      .single();

    if (categoryError || !category) {
      return res.status(400).json({ error: "Invalid category" });
    }

    if (itemType === "CHEMICAL" && !mergedItemFields.hazard_class) {
      return res.status(400).json({ error: "Hazard class required for chemical items" });
    }

    if (
      mergedItemFields.dispensing_unit &&
      (
        mergedItemFields.conversion_factor == null ||
        Number.isNaN(Number(mergedItemFields.conversion_factor)) ||
        Number(mergedItemFields.conversion_factor) <= 0
      )
    ) {
      return res.status(400).json({
        error: "Conversion factor must be greater than 0 when dispensing unit is set",
      });
    }

    const normalizedExtension = normalizeExtensionData(itemType, extension_data);

    if (
      itemType === "EQUIPMENT" &&
      existingItem.item_type !== "EQUIPMENT" &&
      !normalizedExtension.maintenance_interval_days
    ) {
      return res.status(400).json({
        error: "Maintenance interval required for equipment",
      });
    }

    if (
      itemType === "CRM" &&
      existingItem.item_type !== "CRM" &&
      !normalizedExtension.certification_expiry
    ) {
      return res.status(400).json({
        error: "Certification expiry required for CRM",
      });
    }

    if (mergedItemFields.sku !== existingItem.sku) {
      let duplicateQuery = supabase
        .from("items")
        .select("id")
        .eq("sku", mergedItemFields.sku)
        .neq("id", id);

      const scopedLabId = labId ?? existingItem.laboratory_id ?? null;
      if (scopedLabId) duplicateQuery = duplicateQuery.eq("laboratory_id", scopedLabId);

      const { data: duplicate, error: duplicateError } = await duplicateQuery.maybeSingle();
      if (duplicateError) throw duplicateError;

      if (duplicate) {
        return res.status(400).json({
          error: "SKU already exists in this laboratory",
        });
      }
    }

    let updateQuery = supabase
      .from("items")
      .update(mergedItemFields)
      .eq("id", id);

    if (labId) updateQuery = updateQuery.eq("laboratory_id", labId);

    const { error: updateError } = await updateQuery;
    if (updateError) throw updateError;

    await upsertExtensionTable(itemType, id, extension_data);
    await deleteOtherExtensionRows(itemType, id);

    await writeAuditLog({
      userId,
      action: "UPDATE",
      entity: "items",
      entityId: id,
      oldData: existingItem,
      newData: req.body,
    });

    const updatedItem = await fetchSingleItemWithJoins(id, labId);
    return res.json(updatedItem);
  } catch (err) {
    console.error("updateItem error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const deleteItem = async (req, res) => {
  const supabase = getSupabase();
  const labId = req.user.laboratory_id ?? null;
  const userId = req.user.id;
  const { id } = req.params;

  try {
    let q = supabase.from("items").select("*").eq("id", id);
    if (labId) q = q.eq("laboratory_id", labId);

    const { data: existingItem, error: existingErr } = await q.single();

    if (existingErr || !existingItem) {
      return res.status(404).json({ error: "Item not found" });
    }

    let dq = supabase.from("items").delete().eq("id", id);
    if (labId) dq = dq.eq("laboratory_id", labId);

    const { error } = await dq;
    if (error) throw error;

    await writeAuditLog({
      userId,
      action: "DELETE",
      entity: "items",
      entityId: id,
      oldData: existingItem,
    });

    return res.json({ message: "Item deleted successfully" });
  } catch (err) {
    console.error("deleteItem error:", err);
    return res.status(500).json({ error: err.message });
  }
};