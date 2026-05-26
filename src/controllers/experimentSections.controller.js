import { getSupabase } from '../config/supabase.js'
import { v4 as uuidv4 } from 'uuid'
import { normalizeNullableString, safeNumber } from '../utils/helpers.js'

const EDITABLE_STATUSES = ['DRAFT', 'IN_PROGRESS', 'REJECTED']

// Shared: fetch experiment, enforce lab scope and editability
async function guardExperiment(supabase, id, labId, requireEditable = true) {
  let q = supabase.from('experiments').select('id, status, laboratory_id').eq('id', id)
  if (labId) q = q.eq('laboratory_id', labId)
  const { data, error } = await q.single()
  if (error || !data) return { err: 'Experiment not found', status: 404 }
  if (requireEditable && !EDITABLE_STATUSES.includes(data.status)) {
    return { err: `Experiment is ${data.status} and cannot be modified`, status: 400 }
  }
  return { experiment: data }
}

// ── PARTICIPANTS ──────────────────────────────────────────────────────

export const addParticipant = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const { user_id, role = 'STUDENT' } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    if (!user_id) return res.status(400).json({ error: 'user_id is required' })

    const { data, error } = await supabase
      .from('experiment_participants')
      .upsert({ id: uuidv4(), experiment_id: id, user_id, role }, { onConflict: 'experiment_id,user_id' })
      .select('*, app_users(id, full_name)')
      .single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    console.error('[addParticipant]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const removeParticipant = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, pid } = req.params

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })

    const { error } = await supabase.from('experiment_participants')
      .delete().eq('id', pid).eq('experiment_id', id)
    if (error) throw error
    return res.json({ message: 'Participant removed' })
  } catch (err) {
    console.error('[removeParticipant]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── MATERIALS ─────────────────────────────────────────────────────────

export const addMaterial = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const { item_id, batch_id, material_name, quantity_used, unit, lot_number, notes } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    if (!material_name?.trim()) return res.status(400).json({ error: 'material_name is required' })
    const qty = safeNumber(quantity_used)
    if (!qty || qty <= 0) return res.status(400).json({ error: 'quantity_used must be a positive number' })
    if (!unit?.trim())    return res.status(400).json({ error: 'unit is required' })

    const { data, error } = await supabase
      .from('experiment_materials')
      .insert({
        id: uuidv4(), experiment_id: id,
        item_id:       item_id  || null,
        batch_id:      batch_id || null,
        material_name: material_name.trim(),
        quantity_used: qty,
        unit:          unit.trim(),
        lot_number:    normalizeNullableString(lot_number),
        notes:         normalizeNullableString(notes),
      })
      .select('*, items(id, name, sku, unit_of_measure), stock_batches(id, batch_number, expiry_date)')
      .single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    console.error('[addMaterial]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const updateMaterial = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, mid } = req.params

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })

    const updates = {}
    const { material_name, quantity_used, unit, lot_number, notes, item_id, batch_id } = req.body
    if (material_name !== undefined) updates.material_name = material_name.trim()
    if (quantity_used !== undefined) updates.quantity_used = safeNumber(quantity_used)
    if (unit          !== undefined) updates.unit          = unit.trim()
    if (lot_number    !== undefined) updates.lot_number    = normalizeNullableString(lot_number)
    if (notes         !== undefined) updates.notes         = normalizeNullableString(notes)
    if (item_id       !== undefined) updates.item_id       = item_id  || null
    if (batch_id      !== undefined) updates.batch_id      = batch_id || null

    const { data, error } = await supabase
      .from('experiment_materials').update(updates).eq('id', mid).eq('experiment_id', id)
      .select('*, items(id, name, sku), stock_batches(id, batch_number)')
      .single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[updateMaterial]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const deleteMaterial = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, mid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const { error } = await supabase.from('experiment_materials').delete().eq('id', mid).eq('experiment_id', id)
    if (error) throw error
    return res.json({ message: 'Material removed' })
  } catch (err) {
    console.error('[deleteMaterial]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── EQUIPMENT ─────────────────────────────────────────────────────────

export const addEquipment = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const { item_id, equipment_name, model_serial, calibration_status = 'N/A', calibration_date, notes } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    if (!equipment_name?.trim()) return res.status(400).json({ error: 'equipment_name is required' })

    const { data, error } = await supabase
      .from('experiment_equipment')
      .insert({
        id: uuidv4(), experiment_id: id,
        item_id:            item_id || null,
        equipment_name:     equipment_name.trim(),
        model_serial:       normalizeNullableString(model_serial),
        calibration_status,
        calibration_date:   calibration_date || null,
        notes:              normalizeNullableString(notes),
      })
      .select('*, items(id, name, sku)').single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    console.error('[addEquipment]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const updateEquipment = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, eid } = req.params

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })

    const updates = {}
    const { equipment_name, model_serial, calibration_status, calibration_date, notes, item_id } = req.body
    if (equipment_name     !== undefined) updates.equipment_name     = equipment_name.trim()
    if (model_serial       !== undefined) updates.model_serial       = normalizeNullableString(model_serial)
    if (calibration_status !== undefined) updates.calibration_status = calibration_status
    if (calibration_date   !== undefined) updates.calibration_date   = calibration_date || null
    if (notes              !== undefined) updates.notes              = normalizeNullableString(notes)
    if (item_id            !== undefined) updates.item_id            = item_id || null

    const { data, error } = await supabase
      .from('experiment_equipment').update(updates).eq('id', eid).eq('experiment_id', id)
      .select('*, items(id, name, sku)').single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[updateEquipment]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const deleteEquipment = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, eid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const { error } = await supabase.from('experiment_equipment').delete().eq('id', eid).eq('experiment_id', id)
    if (error) throw error
    return res.json({ message: 'Equipment removed' })
  } catch (err) {
    console.error('[deleteEquipment]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── SAFETY (upsert) ───────────────────────────────────────────────────

export const upsertSafety = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const { ppe_used, fume_hood_used, fume_hood_id, hazard_level, biosafety_level, other_precautions } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })

    const payload = {
      experiment_id:      id,
      ppe_used:           Array.isArray(ppe_used) ? ppe_used : [],
      fume_hood_used:     Boolean(fume_hood_used),
      fume_hood_id:       normalizeNullableString(fume_hood_id),
      hazard_level:       hazard_level || 'LOW',
      biosafety_level:    normalizeNullableString(biosafety_level),
      other_precautions:  normalizeNullableString(other_precautions),
    }

    const { data, error } = await supabase
      .from('experiment_safety')
      .upsert(payload, { onConflict: 'experiment_id' })
      .select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[upsertSafety]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── PROCEDURE STEPS ───────────────────────────────────────────────────

export const addStep = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const { step_number, description, conditions = {}, is_deviation = false, deviation_note } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    if (!description?.trim()) return res.status(400).json({ error: 'description is required' })

    // Auto-assign step number if not provided
    let stepNum = parseInt(step_number, 10)
    if (!stepNum) {
      const { count } = await supabase
        .from('experiment_procedure_steps').select('id', { count: 'exact', head: true }).eq('experiment_id', id)
      stepNum = (count || 0) + 1
    }

    const { data, error } = await supabase
      .from('experiment_procedure_steps')
      .insert({
        id: uuidv4(), experiment_id: id,
        step_number: stepNum,
        description: description.trim(),
        conditions:  typeof conditions === 'object' ? conditions : {},
        is_deviation: Boolean(is_deviation),
        deviation_note: normalizeNullableString(deviation_note),
      })
      .select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    console.error('[addStep]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const updateStep = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, sid } = req.params

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })

    const updates = {}
    const { step_number, description, conditions, is_deviation, deviation_note } = req.body
    if (step_number    !== undefined) updates.step_number    = parseInt(step_number, 10)
    if (description    !== undefined) updates.description    = description.trim()
    if (conditions     !== undefined) updates.conditions     = conditions
    if (is_deviation   !== undefined) updates.is_deviation   = Boolean(is_deviation)
    if (deviation_note !== undefined) updates.deviation_note = normalizeNullableString(deviation_note)

    const { data, error } = await supabase
      .from('experiment_procedure_steps').update(updates).eq('id', sid).eq('experiment_id', id)
      .select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[updateStep]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const deleteStep = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, sid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const { error } = await supabase.from('experiment_procedure_steps').delete().eq('id', sid).eq('experiment_id', id)
    if (error) throw error
    return res.json({ message: 'Step removed' })
  } catch (err) {
    console.error('[deleteStep]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── CONTROLS ──────────────────────────────────────────────────────────

export const addControl = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const { control_type, description, expected_value, actual_value, unit, passed } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    if (!control_type)        return res.status(400).json({ error: 'control_type is required' })
    if (!description?.trim()) return res.status(400).json({ error: 'description is required' })

    const { data, error } = await supabase.from('experiment_controls')
      .insert({
        id: uuidv4(), experiment_id: id,
        control_type, description: description.trim(),
        expected_value: normalizeNullableString(expected_value),
        actual_value:   normalizeNullableString(actual_value),
        unit:           normalizeNullableString(unit),
        passed:         passed === undefined ? null : Boolean(passed),
      })
      .select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    console.error('[addControl]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const updateControl = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, cid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const updates = {}
    const { control_type, description, expected_value, actual_value, unit, passed } = req.body
    if (control_type    !== undefined) updates.control_type    = control_type
    if (description     !== undefined) updates.description     = description.trim()
    if (expected_value  !== undefined) updates.expected_value  = normalizeNullableString(expected_value)
    if (actual_value    !== undefined) updates.actual_value    = normalizeNullableString(actual_value)
    if (unit            !== undefined) updates.unit            = normalizeNullableString(unit)
    if (passed          !== undefined) updates.passed          = passed === null ? null : Boolean(passed)
    const { data, error } = await supabase.from('experiment_controls').update(updates).eq('id', cid).eq('experiment_id', id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[updateControl]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const deleteControl = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, cid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const { error } = await supabase.from('experiment_controls').delete().eq('id', cid).eq('experiment_id', id)
    if (error) throw error
    return res.json({ message: 'Control removed' })
  } catch (err) {
    console.error('[deleteControl]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── OBSERVATIONS ──────────────────────────────────────────────────────

export const addObservation = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const { step_id, observation_type = 'QUANTITATIVE', label, value, unit, replicate_number, instrument_settings, notes } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    if (!label?.trim()) return res.status(400).json({ error: 'label is required' })

    const { data, error } = await supabase.from('experiment_observations')
      .insert({
        id: uuidv4(), experiment_id: id,
        step_id:             step_id || null,
        observation_type,
        label:               label.trim(),
        value:               normalizeNullableString(value),
        unit:                normalizeNullableString(unit),
        replicate_number:    replicate_number ? parseInt(replicate_number, 10) : null,
        instrument_settings: typeof instrument_settings === 'object' ? instrument_settings : {},
        notes:               normalizeNullableString(notes),
        recorded_at:         new Date(),
      })
      .select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    console.error('[addObservation]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const updateObservation = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, oid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const updates = {}
    const { label, value, unit, replicate_number, instrument_settings, notes, observation_type, step_id } = req.body
    if (label               !== undefined) updates.label               = label.trim()
    if (value               !== undefined) updates.value               = normalizeNullableString(value)
    if (unit                !== undefined) updates.unit                = normalizeNullableString(unit)
    if (replicate_number    !== undefined) updates.replicate_number    = replicate_number ? parseInt(replicate_number, 10) : null
    if (instrument_settings !== undefined) updates.instrument_settings = instrument_settings
    if (notes               !== undefined) updates.notes               = normalizeNullableString(notes)
    if (observation_type    !== undefined) updates.observation_type    = observation_type
    if (step_id             !== undefined) updates.step_id             = step_id || null
    const { data, error } = await supabase.from('experiment_observations').update(updates).eq('id', oid).eq('experiment_id', id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[updateObservation]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const deleteObservation = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, oid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const { error } = await supabase.from('experiment_observations').delete().eq('id', oid).eq('experiment_id', id)
    if (error) throw error
    return res.json({ message: 'Observation removed' })
  } catch (err) {
    console.error('[deleteObservation]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── RESULTS ───────────────────────────────────────────────────────────

export const addResult = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const { label, result_type = 'CALCULATED', value, unit, expected_value, deviation_percent, uncertainty, method, notes } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    if (!label?.trim()) return res.status(400).json({ error: 'label is required' })

    const { data, error } = await supabase.from('experiment_results')
      .insert({
        id: uuidv4(), experiment_id: id,
        label: label.trim(), result_type,
        value:             safeNumber(value),
        unit:              normalizeNullableString(unit),
        expected_value:    safeNumber(expected_value),
        deviation_percent: safeNumber(deviation_percent),
        uncertainty:       safeNumber(uncertainty),
        method:            normalizeNullableString(method),
        notes:             normalizeNullableString(notes),
      })
      .select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    console.error('[addResult]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const updateResult = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, rid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const updates = {}
    const { label, result_type, value, unit, expected_value, deviation_percent, uncertainty, method, notes } = req.body
    if (label             !== undefined) updates.label             = label.trim()
    if (result_type       !== undefined) updates.result_type       = result_type
    if (value             !== undefined) updates.value             = safeNumber(value)
    if (unit              !== undefined) updates.unit              = normalizeNullableString(unit)
    if (expected_value    !== undefined) updates.expected_value    = safeNumber(expected_value)
    if (deviation_percent !== undefined) updates.deviation_percent = safeNumber(deviation_percent)
    if (uncertainty       !== undefined) updates.uncertainty       = safeNumber(uncertainty)
    if (method            !== undefined) updates.method            = normalizeNullableString(method)
    if (notes             !== undefined) updates.notes             = normalizeNullableString(notes)
    const { data, error } = await supabase.from('experiment_results').update(updates).eq('id', rid).eq('experiment_id', id).select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[updateResult]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const deleteResult = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, rid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const { error } = await supabase.from('experiment_results').delete().eq('id', rid).eq('experiment_id', id)
    if (error) throw error
    return res.json({ message: 'Result removed' })
  } catch (err) {
    console.error('[deleteResult]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── CONCLUSIONS (upsert) ──────────────────────────────────────────────

export const upsertConclusions = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const { key_findings, error_sources, limitations, improvement_suggestions, follow_up_experiments } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })

    const { data, error } = await supabase.from('experiment_conclusions')
      .upsert({
        experiment_id:          id,
        key_findings:           normalizeNullableString(key_findings),
        error_sources:          normalizeNullableString(error_sources),
        limitations:            normalizeNullableString(limitations),
        improvement_suggestions: normalizeNullableString(improvement_suggestions),
        follow_up_experiments:  normalizeNullableString(follow_up_experiments),
      }, { onConflict: 'experiment_id' })
      .select().single()
    if (error) throw error
    return res.json(data)
  } catch (err) {
    console.error('[upsertConclusions]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── WASTE RECORDS ─────────────────────────────────────────────────────

export const addWasteRecord = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const userId   = req.user.id
  const { id }   = req.params
  const { waste_description, waste_type = 'NON_HAZARDOUS', quantity, unit, disposal_method, disposal_date } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    if (!waste_description?.trim()) return res.status(400).json({ error: 'waste_description is required' })

    const { data, error } = await supabase.from('experiment_waste_records')
      .insert({
        id: uuidv4(), experiment_id: id,
        waste_description: waste_description.trim(), waste_type,
        quantity:       safeNumber(quantity),
        unit:           normalizeNullableString(unit),
        disposal_method: normalizeNullableString(disposal_method),
        disposal_date:  disposal_date || null,
        disposed_by:    userId,
      })
      .select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    console.error('[addWasteRecord]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const deleteWasteRecord = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, wid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const { error } = await supabase.from('experiment_waste_records').delete().eq('id', wid).eq('experiment_id', id)
    if (error) throw error
    return res.json({ message: 'Waste record removed' })
  } catch (err) {
    console.error('[deleteWasteRecord]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

// ── ETHICAL APPROVALS ─────────────────────────────────────────────────

export const addEthicalApproval = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id }   = req.params
  const { approval_type, approval_number, approving_body, approval_date, expiry_date, document_path } = req.body

  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    if (!approval_type) return res.status(400).json({ error: 'approval_type is required' })

    const { data, error } = await supabase.from('experiment_ethical_approvals')
      .insert({
        id: uuidv4(), experiment_id: id,
        approval_type,
        approval_number: normalizeNullableString(approval_number),
        approving_body:  normalizeNullableString(approving_body),
        approval_date:   approval_date || null,
        expiry_date:     expiry_date   || null,
        document_path:   normalizeNullableString(document_path),
      })
      .select().single()
    if (error) throw error
    return res.status(201).json(data)
  } catch (err) {
    console.error('[addEthicalApproval]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}

export const deleteEthicalApproval = async (req, res) => {
  const supabase = getSupabase()
  const labId    = req.user.laboratory_id ?? null
  const { id, apid } = req.params
  try {
    const { err, status } = await guardExperiment(supabase, id, labId)
    if (err) return res.status(status).json({ error: err })
    const { error } = await supabase.from('experiment_ethical_approvals').delete().eq('id', apid).eq('experiment_id', id)
    if (error) throw error
    return res.json({ message: 'Approval record removed' })
  } catch (err) {
    console.error('[deleteEthicalApproval]', err)
    return res.status(500).json({ error: 'An internal error occurred' })
  }
}
