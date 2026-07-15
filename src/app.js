import express from 'express'
import cors    from 'cors'

import { globalLimiter, authLimiter } from './middleware/rateLimiter.js'

import authRoutes         from './routes/auth.routes.js'
import categoriesRoutes   from './routes/categories.routes.js'
import itemsRoutes        from './routes/items.routes.js'
import batchRoutes        from './routes/stockBatches.routes.js'
import transactionRoutes  from './routes/stockTransactions.routes.js'
import dashboardRoutes    from './routes/dashboard.routes.js'
import laboratoriesRoutes from './routes/laboratories.routes.js'
import reportsRoutes      from './routes/reports.routes.js'
import experimentsRoutes  from './routes/experiments.routes.js'
import studentsRoutes     from './routes/students.routes.js'
import usersRoutes        from './routes/users.routes.js'
import bookingsRoutes     from './routes/bookings.routes.js'

const app = express()

// ── CORS ──────────────────────────────────────────────────────────────
// CORS_ORIGIN should be set to your frontend URL(s) in production.
// Accepts a single URL or a comma-separated list:
//   CORS_ORIGIN=https://my-app.vercel.app
//   CORS_ORIGIN=https://my-app.vercel.app,https://staging.my-app.com
//
// If the variable is missing the server still starts (we warn loudly
// rather than crash), but all cross-origin requests will be blocked
// in production until the variable is set.
const rawCorsOrigin = process.env.CORS_ORIGIN

let corsOrigin
if (rawCorsOrigin) {
  const origins = rawCorsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
  corsOrigin = origins.length === 1 ? origins[0] : origins
} else if (process.env.NODE_ENV === 'production') {
  console.warn(
    '[CORS] WARNING: CORS_ORIGIN env var is not set. ' +
    'All cross-origin requests will be rejected. ' +
    'Set CORS_ORIGIN to your frontend URL in Render → Environment.'
  )
  corsOrigin = false
} else {
  // Development: allow all origins so localhost:5173 → localhost:5000 works
  // without requiring CORS_ORIGIN in .env
  corsOrigin = '*'
}

app.use(cors({
  origin:         corsOrigin,
  credentials:    true,
  methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-lab-id'],
}))

// ── Body parsing ───────────────────────────────────────────────────────
// 1 MB limit — prevents large-payload DoS.
app.use(express.json({ limit: '1mb' }))

// ── Rate limiting ──────────────────────────────────────────────────────
app.use(globalLimiter)

// ── Health checks (unauthenticated, used by uptime monitors) ──────────
app.get('/health',     (_req, res) => res.json({ status: 'OK', service: 'Lab Inventory Backend' }))
app.get('/api/health', (_req, res) => res.json({ status: 'OK', service: 'Lab Inventory Backend' }))

// ── Auth routes get a tighter limiter ─────────────────────────────────
app.use('/api/auth',          authLimiter, authRoutes)

// ── All other routes ───────────────────────────────────────────────────
app.use('/api/categories',    categoriesRoutes)
app.use('/api/items',         itemsRoutes)
app.use('/api/batches',       batchRoutes)
app.use('/api/transactions',  transactionRoutes)
app.use('/api/dashboard',     dashboardRoutes)
app.use('/api/laboratories',  laboratoriesRoutes)
app.use('/api/reports',       reportsRoutes)
app.use('/api/experiments',   experimentsRoutes)
app.use('/api/students',      studentsRoutes)
app.use('/api/users',         usersRoutes)
app.use('/api/bookings',      bookingsRoutes)

// ── Global error handler ───────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err)
  res.status(500).json({ error: 'Internal server error' })
})

export default app
