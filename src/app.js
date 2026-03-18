import express from "express";
import cors from "cors";

import authRoutes        from "./routes/auth.routes.js";
import categoriesRoutes  from "./routes/categories.routes.js";
import itemsRoutes       from "./routes/items.routes.js";
import batchRoutes       from "./routes/stockBatches.routes.js";
import transactionRoutes from "./routes/stockTransactions.routes.js";
import dashboardRoutes   from "./routes/dashboard.routes.js";

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "OK", service: "Lab Inventory Backend" });
});

app.use("/api/auth",         authRoutes);
app.use("/api/categories",   categoriesRoutes);
app.use("/api/items",        itemsRoutes);
app.use("/api/batches",      batchRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/dashboard",    dashboardRoutes);

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;