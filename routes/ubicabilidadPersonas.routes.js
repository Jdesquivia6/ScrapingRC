const express = require('express');
const multer = require('multer');
const router = express.Router();

const {
  validarArchivo,
  obtenerDocumentosParaProcesar,
  listarResultados
} = require('../controllers/ubicabilidadPersonas.controller');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// Validar archivo Excel/CSV
router.post('/validar-archivo', upload.single('archivo'), validarArchivo);

// Obtener estado de documentos en BD antes de procesar
router.post('/obtener-documentos', obtenerDocumentosParaProcesar);

// Listar resultados con paginación
router.get('/resultados', listarResultados);

module.exports = router;
