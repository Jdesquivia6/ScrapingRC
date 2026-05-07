const express = require('express');
const router = express.Router();

const {
  procesarDatosVehiculoBatch,
  listarHistorialConsultas
} = require('../controllers/datosVehiculo.controller');

router.post('/procesar-batch', procesarDatosVehiculoBatch);

router.get('/', listarHistorialConsultas);

module.exports = router;