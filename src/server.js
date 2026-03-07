require("dotenv").config();
const app = require("./app");
import itemsRoutes from './routes/items.routes.js'

app.use('/api/items', itemsRoutes)
import authRoutes from './routes/auth.routes.js'

import batchRoutes from './routes/stockBatches.routes.js'

app.use('/api/batches', batchRoutes)

import transactionRoutes from './routes/stockTransactions.routes.js'

app.use('/api/transactions', transactionRoutes)

import dashboardRoutes from './routes/dashboard.routes.js'

app.use('/api/dashboard', dashboardRoutes)

app.use('/api/auth', authRoutes)
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});