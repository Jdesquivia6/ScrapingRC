const express = require('express');
const router = express.Router();

const { verifyToken } = require('../middlewares/authMiddleware');

const {
  crearJob,
  listarJobs,
  obtenerDetalleJob,
  obtenerProgresoJob,
  cancelarJob,
  reintentarFallidos,
  tomarSiguienteJob,
  catalogoEstados,
  actualizarEstadoItem,
  actualizarEstadoJobWorker,
  workerHeartbeat
} = require('../controllers/workerJobs.controller');

router.get('/catalogos/estados', verifyToken, catalogoEstados);

router.post('/', verifyToken, crearJob);
router.get('/', verifyToken, listarJobs);
router.get('/:id', verifyToken, obtenerDetalleJob);

router.post('/:id/cancelar', verifyToken, cancelarJob);
router.post('/:id/reintentar-fallidos', verifyToken, reintentarFallidos);
router.get('/:id/progreso', verifyToken, obtenerProgresoJob);

router.post('/worker/tomar-siguiente', verifyToken, tomarSiguienteJob);
router.post('/worker/heartbeat', verifyToken, workerHeartbeat);
router.post('/:id/worker/item-estado', verifyToken, actualizarEstadoItem);
router.post('/:id/worker/estado', verifyToken, actualizarEstadoJobWorker);

module.exports = router;
