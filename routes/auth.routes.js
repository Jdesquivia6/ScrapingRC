const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/authMiddleware');

const {
  login,
  recuperarPassword,
  cambiarMiPassword
} = require('../controllers/auth.controller');

router.post('/login', login);
router.post('/recuperar-password', recuperarPassword);
router.patch('/mi-password', verifyToken, cambiarMiPassword);

module.exports = router;