const express = require('express');
const router = express.Router();

const {
  iniciarSesion,
  reiniciarSesion,
  estadoSesion
} = require('../controllers/runtSession.controller');

router.post('/iniciar', iniciarSesion);
router.post('/reiniciar', reiniciarSesion);
router.get('/estado', estadoSesion);

module.exports = router;