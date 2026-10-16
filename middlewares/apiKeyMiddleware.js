const crypto = require('crypto');
const pool = require('../utils/db');

/**
 * Autenticación por header X-API-Key para la API de integraciones.
 *
 * Flujo:
 *   X-API-Key -> SHA-256 -> buscar api_client por token_hash
 *   -> 401 si no existe -> 403 si inactivo o sin permiso -> req.apiClient
 *
 * Nunca se registra la API key completa en logs ni en respuestas.
 */

// Ventana deslizante simple en memoria por cliente (no requiere librería externa).
const RATE_WINDOW_MS = 60 * 1000;
const rateBuckets = new Map();

function limpiarBuckets() {
  try {
    const ahora = Date.now();
    for (const [clave, bucket] of rateBuckets) {
      if (ahora - bucket.inicio > RATE_WINDOW_MS * 2) rateBuckets.delete(clave);
    }
  } catch (_) {
    /* limpieza no crítica */
  }
}
setInterval(limpiarBuckets, RATE_WINDOW_MS * 5).unref();

function excedeRateLimit(idClient) {
  const maximo = Number(process.env.API_RATE_LIMIT) || 120;
  const ahora = Date.now();
  let bucket = rateBuckets.get(idClient);

  if (!bucket || ahora - bucket.inicio > RATE_WINDOW_MS) {
    bucket = { inicio: ahora, contador: 0 };
    rateBuckets.set(idClient, bucket);
  }

  bucket.contador += 1;
  return bucket.contador > maximo;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/** Prohíbe registrar la API key. Enmascara cualquier parecido a sk_live_... */
function enmascarar(texto) {
  return String(texto || '').replace(/sk_live_[A-Za-z0-9_-]+/g, 'sk_live_***');
}

exports.autenticarApiKey = (permiso = 'puede_consultar') => {
  return async (req, res, next) => {
    try {
      const apiKey = req.header('X-API-Key');

      if (!apiKey || !apiKey.trim()) {
        return res.status(401).json({ ok: false, error: 'API key requerida en el header X-API-Key' });
      }

      const tokenHash = hashApiKey(apiKey.trim());

      const resultado = await pool.query(
        `SELECT id_api_client, codigo, nombre, activo, puede_insertar, puede_consultar
         FROM api_client
         WHERE token_hash = $1
         LIMIT 1`,
        [tokenHash]
      );

      const cliente = resultado.rows[0];

      if (!cliente) {
        return res.status(401).json({ ok: false, error: 'API key inválida' });
      }

      if (!cliente.activo) {
        return res.status(403).json({ ok: false, error: 'Cliente inactivo' });
      }

      if (!cliente[permiso]) {
        return res.status(403).json({ ok: false, error: 'Cliente sin permiso para esta operación' });
      }

      if (excedeRateLimit(cliente.id_api_client)) {
        return res.status(429).json({ ok: false, error: 'Demasiadas solicitudes, intente más tarde' });
      }

      req.apiClient = cliente;

      // Fecha de último uso (no bloquea la respuesta)
      pool.query(
        'UPDATE api_client SET fecha_ultimo_uso = NOW() WHERE id_api_client = $1',
        [cliente.id_api_client]
      ).catch(() => {});

      next();
    } catch (error) {
      // Nunca exponer detalles internos del servidor
      console.error('[api-key] error de autenticación:', enmascarar(error.message));
      return res.status(500).json({ ok: false, error: 'Error de autenticación' });
    }
  };
};

exports.enmascarar = enmascarar;
exports.hashApiKey = hashApiKey;
