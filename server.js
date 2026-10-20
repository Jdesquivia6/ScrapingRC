require('dotenv').config();
const express = require('express');

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
const integracionesRoutes = require('./routes/integracionesUbicabilidad.routes');
const {
  exportarDashboardExcel
} = require('./controllers/dashboard.controller');

const app = express();

const allowedOrigins = [
  // Producción mediante IP
  'http://84.247.165.214:5173',

  // Nuevo dominio AutoCore
  'http://www.autocore.cloud:5173',
  'http://autocore.cloud:5173',

  // Futuro acceso mediante HTTPS
  'https://www.autocore.cloud',
  'https://autocore.cloud',

  // Desarrollo local
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // Permitir solicitudes sin Origin y orígenes autorizados
  if (origin && !allowedOrigins.includes(origin)) {
    if (req.method === 'OPTIONS') {
      return res.sendStatus(403);
    }

    return next();
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-API-Key'
  );

  res.setHeader('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

// Límite ampliado para soportar cargas masivas de integraciones (miles de personas)
app.use(express.json({ limit: '5mb' }));

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

// API de integración para sistemas externos (autenticación por X-API-Key)
app.use('/api/v1/integraciones', integracionesRoutes);

app.listen(process.env.PORT, () => {
  console.log(`API corriendo en puerto ${process.env.PORT}`);
});
