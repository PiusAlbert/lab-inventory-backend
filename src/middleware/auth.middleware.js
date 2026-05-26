import { getSupabase } from '../config/supabase.js'

// ── In-memory TTL caches ─────────────────────────────────────────────
// These avoid a DB round-trip on every authenticated request.
// They are process-local, so a rolling deploy or scale-out to multiple
// processes will simply result in a cache miss (safe, just slower).
//
// Cache entries are invalidated by calling invalidateProfileCache(userId)
// from any route that changes a user's role, lab assignment, or status.

const PROFILE_TTL_MS = 60  * 1000   // 60 seconds
const LAB_TTL_MS     = 300 * 1000   // 5 minutes (lab data changes rarely)

const profileCache = new Map()   // userId → { data, cachedAt }
const labCache     = new Map()   // labId  → { data, cachedAt }

function cacheGet(cache, key, ttl) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.cachedAt > ttl) {
    cache.delete(key)
    return null
  }
  return entry.data
}

function cacheSet(cache, key, data) {
  cache.set(key, { data, cachedAt: Date.now() })
}

/** Call this when a user's role, lab, or active status is changed. */
export function invalidateProfileCache(userId) {
  profileCache.delete(userId)
}

/** Call this when a laboratory's active status is toggled. */
export function invalidateLabCache(labId) {
  labCache.delete(labId)
}

// ── Middleware ────────────────────────────────────────────────────────
/**
 * VERIFY SUPABASE JWT
 *
 * Role and laboratory assignment come from public.app_users — NOT from
 * JWT metadata — so that role changes take effect immediately without
 * requiring a token re-issue.
 *
 * Profile results are cached for PROFILE_TTL_MS (60 s) per user.
 * Laboratory validation results are cached for LAB_TTL_MS (5 min).
 *
 * Effective laboratory:
 *   Regular user  → always their assigned laboratory_id
 *   SUPER_ADMIN + x-lab-id header → that lab (validated once, then cached)
 *   SUPER_ADMIN + no header        → null (all-labs read mode)
 */
export const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' })
    }

    const token    = authHeader.split(' ')[1]
    const supabase = getSupabase()

    // ── 1. Verify JWT (always — we must not cache token validity) ────
    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired token' })
    }

    const authUser = data.user

    // ── 2. Load user profile (cached) ────────────────────────────────
    let appUser = cacheGet(profileCache, authUser.id, PROFILE_TTL_MS)

    if (!appUser) {
      const { data: fetched, error: appError } = await supabase
        .from('app_users')
        .select('id, full_name, role, laboratory_id, is_active')
        .eq('id', authUser.id)
        .maybeSingle()

      if (appError) {
        console.error('[auth] app_users lookup error:', appError.message)
        return res.status(500).json({ error: 'Failed to load user profile' })
      }

      if (!fetched) {
        return res.status(403).json({ error: 'User profile not found. Contact your administrator.' })
      }

      appUser = fetched
      cacheSet(profileCache, authUser.id, appUser)
    }

    // ── 3. Guard checks (do NOT cache these — they must be live) ─────
    if (!appUser.is_active) {
      invalidateProfileCache(authUser.id)  // don't serve stale deactivations
      return res.status(403).json({ error: 'User account is deactivated' })
    }

    if (!appUser.role) {
      return res.status(403).json({ error: 'User has no role assigned' })
    }

    const isSuperAdmin = appUser.role === 'SUPER_ADMIN'

    if (!isSuperAdmin && !appUser.laboratory_id) {
      return res.status(403).json({ error: 'User has no laboratory assigned' })
    }

    // ── 4. Resolve SUPER_ADMIN lab override ───────────────────────────
    const rawLabOverride = req.headers['x-lab-id']
    const labOverride =
      rawLabOverride &&
      rawLabOverride !== 'null' &&
      rawLabOverride !== 'undefined' &&
      String(rawLabOverride).trim() !== ''
        ? String(rawLabOverride).trim()
        : null

    let validatedLabOverride = null

    if (isSuperAdmin && labOverride) {
      // Try cache first
      let lab = cacheGet(labCache, labOverride, LAB_TTL_MS)

      if (!lab) {
        const { data: fetchedLab, error: labError } = await supabase
          .from('laboratories')
          .select('id, is_active')
          .eq('id', labOverride)
          .maybeSingle()

        if (labError) {
          console.error('[auth] laboratory lookup error:', labError.message)
          return res.status(500).json({ error: 'Failed to validate selected laboratory' })
        }

        lab = fetchedLab
        if (lab) cacheSet(labCache, labOverride, lab)
      }

      if (!lab || lab.is_active === false) {
        return res.status(400).json({ error: 'Selected laboratory is invalid or inactive' })
      }

      validatedLabOverride = lab.id
    }

    // ── 5. Attach resolved context to request ─────────────────────────
    req.user = {
      id:                     authUser.id,
      email:                  authUser.email,
      full_name:              appUser.full_name,
      role:                   appUser.role,
      is_admin:               isSuperAdmin,
      profile_laboratory_id:  appUser.laboratory_id ?? null,
      laboratory_id:          isSuperAdmin ? validatedLabOverride : appUser.laboratory_id,
      selected_laboratory_id: validatedLabOverride,
    }

    return next()
  } catch (err) {
    console.error('[auth] verifyToken error:', err)
    return res.status(500).json({ error: 'Authentication failed' })
  }
}
