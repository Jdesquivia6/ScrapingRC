const express = require('express');
const router = express.Router();

const {
  iniciarSesion,
  iniciarSesionPage,
  reiniciarSesion,
  estadoSesion
} = require('../controllers/runtSession.controller');

router.post('/iniciar', iniciarSesion);
router.get('/iniciar', iniciarSesionPage);
router.post('/reiniciar', reiniciarSesion);
router.get('/estado', estadoSesion);

module.exports = router;
