require('dotenv').config();
const express = require('express');
const cors = require('cors');

// const civitransRoutes = require('./routes/civitrans.routes');
const civitransRoutes = require('./routes/runt.routes')
const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/civitrans', civitransRoutes);

app.listen(process.env.PORT, () => {
  console.log(`API Civitrans corriendo en puerto ${process.env.PORT}`);
});
