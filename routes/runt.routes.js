const express = require('express');
const router = express.Router();

const {
  consultarDireccionesPN,
  consultarDireccionesPNBatch,
  listarPersonasPendientesDirecciones,
  listarHistorialDirecciones,
  listarConsolidado
} = require('../controllers/runt.controller');

router.get('/personas-pendientes-direcciones', listarPersonasPendientesDirecciones);
router.get('/historial-direcciones', listarHistorialDirecciones);

// Vista consolidada general (todos los orígenes, con filtros)
router.get('/consolidado', listarConsolidado);

router.post('/consultar-direcciones-pn', consultarDireccionesPN);
router.post('/consultar-direcciones-pn-batch', consultarDireccionesPNBatch);

module.exports = router;
