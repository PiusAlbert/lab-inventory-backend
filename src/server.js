import app from "./app.js";

import itemsRoutes from "./routes/items.routes.js";
import authRoutes from "./routes/auth.routes.js";
import batchRoutes from "./routes/stockBatches.routes.js";
import transactionRoutes from "./routes/stockTransactions.routes.js";
import dashboardRoutes from "./routes/dashboard.routes.js";

/**
 * API Routes
 */

app.use("/api/auth", authRoutes);
app.use("/api/items", itemsRoutes);
app.use("/api/batches", batchRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/dashboard", dashboardRoutes);

/**
 * Server Port
 */

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});