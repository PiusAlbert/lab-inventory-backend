import express from "express"
import cors from "cors"

import categoriesRoutes from "./routes/categories.routes.js"
import authRoutes from "./routes/auth.routes.js"
import itemsRoutes from "./routes/items.routes.js"
import stockBatchesRoutes from "./routes/stockBatches.routes.js"
import stockTransactionsRoutes from "./routes/stockTransactions.routes.js"
import dashboardRoutes from "./routes/dashboard.routes.js"

const app = express()

/**
 * Allowed Frontend Origins
 */

const allowedOrigins = [
  "http://localhost:5173",   // Vite dev server
  "http://localhost:3000",   // Next.js dev server
  "https://your-frontend-domain.com"
]

/**
 * CORS Configuration
 */

app.use(cors({
  origin: function (origin, callback) {

    // allow requests without origin (Postman / curl)
    if (!origin) return callback(null, true)

    if (allowedOrigins.includes(origin)) {
      return callback(null, true)
    }

    return callback(new Error("CORS not allowed"), false)
  },

  credentials: true,

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS"
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization"
  ]
}))

/**
 * Handle Preflight Requests
 */

app.options("*", cors())

/**
 * Body Parser
 */

app.use(express.json())

/**
 * Health Check
 */

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    service: "Lab Inventory Backend"
  })
})

/**
 * API Routes
 */

app.use("/api/auth", authRoutes)
app.use("/api/categories", categoriesRoutes)
app.use("/api/items", itemsRoutes)
app.use("/api/stockBatches", stockBatchesRoutes)
app.use("/api/stockTransactions", stockTransactionsRoutes)
app.use("/api/dashboard", dashboardRoutes)

export default app