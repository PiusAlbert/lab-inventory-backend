/**
 * Returns a new object with all `undefined` values removed.
 * Supabase treats `undefined` and the key being absent differently;
 * this ensures we never accidentally send `undefined` to the DB.
 */
export function cleanObject(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  )
}

/**
 * Accumulates numeric values into a Map.
 * Missing keys are initialised to 0 before adding.
 */
export function addToMap(map, key, value) {
  map.set(key, (map.get(key) || 0) + Number(value || 0))
}

/**
 * Returns the number of whole days until a date string.
 * Negative values mean the date has already passed.
 * Returns null for falsy input.
 */
export function daysUntil(dateStr) {
  if (!dateStr) return null
  return Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24))
}

/**
 * Trims a string value and returns null for empty / null / undefined.
 * Passing `undefined` returns `undefined` (field will be omitted by cleanObject).
 */
export function normalizeNullableString(value) {
  if (value === undefined) return undefined
  if (value === null)      return null
  const trimmed = String(value).trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Converts a value to a number.
 * Returns `fallback` when the value is empty, null, undefined, or NaN.
 */
export function safeNumber(value, fallback = null) {
  if (value === '' || value == null) return fallback
  const n = Number(value)
  return Number.isNaN(n) ? fallback : n
}

/**
 * Same as safeNumber but only accepts strictly positive values.
 * Returns `fallback` for zero, negative, or invalid input.
 */
export function safePositiveNumber(value, fallback = null) {
  const n = safeNumber(value, null)
  return n !== null && n > 0 ? n : fallback
}
