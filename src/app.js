import express from "express";
import cors from "cors";

import categoriesRoutes from "./routes/categories.routes.js";

const app = express();

/**
 * Global Middleware
 */

app.use(cors());
app.use(express.json());

/**
 * Health Check
 */

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    service: "Lab Inventory Backend"
  });
});

/**
 * API Routes
 */

app.use("/api/categories", categoriesRoutes);

export default app;