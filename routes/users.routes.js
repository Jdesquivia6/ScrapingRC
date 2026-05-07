const express = require('express');
const router = express.Router();

const {
  listarUsuarios,
  crearUsuario,
  actualizarUsuario,
  cambiarPasswordUsuario,
  listarModulos
} = require('../controllers/users.controller');

const { verifyToken } = require('../middlewares/authMiddleware');
const { permitirModulo } = require('../middlewares/permissionMiddleware');

router.get('/catalogos/modulos', verifyToken, permitirModulo('configuracion'), listarModulos);

router.get('/', verifyToken, permitirModulo('configuracion'), listarUsuarios);

router.post('/', verifyToken, permitirModulo('configuracion'), crearUsuario);

router.put('/:id', verifyToken, permitirModulo('configuracion'), actualizarUsuario);

router.patch('/:id/password', verifyToken, permitirModulo('configuracion'), cambiarPasswordUsuario);

module.exports = router;