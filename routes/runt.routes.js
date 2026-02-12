const express = require('express');
const router = express.Router();


const {
  consultarDireccionesPN,
  consultarDireccionesPNBatch
} = require('../controllers/runt.controller');


router.post('/consultar-direcciones-pn', consultarDireccionesPN);
router.post('/consultar-direcciones-pn-batch', consultarDireccionesPNBatch);


module.exports = router;
