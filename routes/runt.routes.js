const express = require('express');
const router = express.Router();

const {
  consultarDireccionesPN,
  consultarDireccionesPNBatch,
  listarPersonasPendientesDirecciones
} = require('../controllers/runt.controller');

router.get('/personas-pendientes-direcciones', listarPersonasPendientesDirecciones);

router.post('/consultar-direcciones-pn', consultarDireccionesPN);
router.post('/consultar-direcciones-pn-batch', consultarDireccionesPNBatch);

module.exports = router;