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
const {
  exportarDashboardExcel
} = require('./controllers/dashboard.controller');

const app = express();

app.use(cors());
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

app.listen(process.env.PORT, () => {
  console.log(`API corriendo en puerto ${process.env.PORT}`);
});
