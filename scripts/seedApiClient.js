/**
 * Crea (o rellena) un cliente API en la tabla api_client.
 *
 * Uso:
 *   node scripts/seedApiClient.js CONTRAVENCIONES "Contravenciones"
 *   node scripts/seedApiClient.js CIVITRANS "Civitrans" --key=sk_live_xxx
 *
 * Si no se pasa --key, se genera una y se imprime UNA sola vez.
 * La API key nunca se guarda en texto plano: solo su hash SHA-256.
 */
const crypto = require('crypto');
const pool = require('../utils/db');

function arg(nombre) {
  const prefijo = `--${nombre}=`;
  const hito = process.argv.find(a => a.startsWith(prefijo));
  return hito ? hito.slice(prefijo.length) : null;
}

function hashSha256(valor) {
  return crypto.createHash('sha256').update(String(valor)).digest('hex');
}

function generarApiKey() {
  return `sk_live_${crypto.randomBytes(24).toString('hex')}`;
}

(async () => {
  const codigo = String(process.argv[2] || '').trim().toUpperCase();
  const nombre = String(process.argv[3] || codigo);

  if (!/^[A-Z][A-Z0-9_]{1,49}$/.test(codigo)) {
    console.error('El código debe ir en MAYÚSCULAS, sin espacios (ej: CONTRAVENCIONES, COBRO_COACTIVO, VENTANILLA, CIVITRANS).');
    process.exit(1);
  }

  // Origen que quedará en persona_natural_propietario.origen_registro
  const origen = `API_${codigo}`;
  const apiKey = arg('key') || generarApiKey();
  const tokenHash = hashSha256(apiKey);
  const creadoPor = arg('creado-por') || null;

  try {
    const existente = await pool.query(
      'SELECT id_api_client FROM api_client WHERE codigo = $1',
      [codigo]
    );

    if (existente.rows.length > 0) {
      await pool.query(
        `UPDATE api_client
         SET nombre = $2, token_hash = $3, activo = TRUE,
             puede_insertar = TRUE, puede_consultar = TRUE
         WHERE codigo = $1`,
        [codigo, nombre, tokenHash]
      );
      console.log(`Cliente "${codigo}" actualizado (token rotado).`);
    } else {
      await pool.query(
        `INSERT INTO api_client (codigo, nombre, token_hash, creado_por)
         VALUES ($1, $2, $3, $4)`,
        [codigo, nombre, tokenHash, creadoPor]
      );
      console.log(`Cliente "${codigo}" creado.`);
    }

    console.log('');
    console.log('  Código        :', codigo);
    console.log('  Nombre        :', nombre);
    console.log('  Origen en BD  :', origen);
    console.log('  X-API-Key     :', apiKey);
    console.log('');
    console.log('  ⚠ Guarde la API key ahora: solo se muestra una vez.');
    console.log('  Header de prueba:  X-API-Key: ' + apiKey);
    console.log('');
  } catch (error) {
    console.error('Error:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
