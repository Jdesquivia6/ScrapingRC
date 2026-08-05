const express = require('express');
const router = express.Router();

const {
  iniciarSesion,
  iniciarSesionPage,
  reiniciarSesion,
  estadoSesion,
  simularTest
} = require('../controllers/runtSession.controller');

router.post('/iniciar', iniciarSesion);
router.get('/iniciar', iniciarSesionPage);
router.post('/reiniciar', reiniciarSesion);
router.get('/estado', estadoSesion);
router.post('/test/simular', simularTest);

module.exports = router;
