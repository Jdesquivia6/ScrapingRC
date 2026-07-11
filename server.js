require('dotenv').config();
const express = require('express');
const cors = require('cors');

// const civitransRoutes = require('./routes/civitrans.routes');
const civitransRoutes = require('./routes/runt.routes')
const liquidacionRoutes = require('./routes/liquidacion.routes');
const placasRoutes = require('./routes/placas.routes');
const vehiculoRoutes = require('./routes/vehiculo.rouetes');
const datosVehiculoRoutes = require('./routes/datosVehiculo.routes');
const placasPendientesRoutes = require('./routes/placasPendientes.routes');
const runtSessionRoutes = require('./routes/runtSession.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const authRoutes = require('./routes/auth.routes');
const usersRoutes = require('./routes/users.routes');
const workerJobsRoutes = require('./routes/workerJobs.routes');
const historialRoutes = require('./routes/historial.routes');
const configRoutes = require('./routes/config.routes');
const ubicabilidadPersonasRoutes = require('./routes/ubicabilidadPersonas.routes');
const {
  exportarDashboardExcel
} = require('./controllers/dashboard.controller');

const app = express();

const allowedOrigins = [
  'http://84.247.165.214:5173',  // Frontend en producción
  'http://localhost:5173',        // Desarrollo local
  'http://127.0.0.1:5173',        // Desarrollo local
  'http://localhost:3000'         // Origen local
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowOrigin = !origin || allowedOrigins.includes(origin)
    ? (origin || '*')
    : false;

  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

app.use(express.json());

app.use('/api/personas/direcciones', civitransRoutes);
app.use('/api/liquidacion', liquidacionRoutes);
app.use('/api/placas', placasRoutes);
app.use('/api/vehiculos', vehiculoRoutes);
app.use('/api/datos-vehiculo', datosVehiculoRoutes);
app.use('/api/historial-vehiculos', datosVehiculoRoutes);
app.use('/api/placas-pendientes', placasPendientesRoutes);
app.use('/api/runt-session', runtSessionRoutes);
app.get('/api/dashboard/exportar-excel', exportarDashboardExcel);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/worker-jobs', workerJobsRoutes);
app.use('/api/historial', historialRoutes);
app.use('/api/config', configRoutes);
app.use('/api/ubicabilidad-personas', ubicabilidadPersonasRoutes);

app.listen(process.env.PORT, () => {
  console.log(`API corriendo en puerto ${process.env.PORT}`);
});
