// Diagnóstico del flujo de scraping de direcciones (personas-direcciones /
// ubicabilidad-personas) contra RUNT.
//
// Uso:
//   node scripts/diagDirecciones.js 1234567890            # tipo por defecto CC
//   node scripts/diagDirecciones.js 1234567890 "PPT"
//
// Requisitos:
//   - Chrome abierto con  --remote-debugging-port=9222
//   - Sesión RUNT iniciada en ese Chrome
//
// NO modifica la base de datos: solo lee el estado de la persona antes y después.

const { chromium } = require('playwright');
const pool = require('../utils/db');
const { scrapeDireccionesPN } = require('../scraping/runtScraper');

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';

async function checkCDP() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`);
    const info = await res.json();
    console.log('✅ Chrome CDP responde en', CDP_URL);
    console.log('   ', info.Browser || 'sin info de navegador');
    return true;
  } catch (err) {
    console.log('❌ No responde el Chrome en', CDP_URL);
    console.log('   Arranca Chrome con:');
    console.log('   chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\\chrome-debug"');
    console.log('   Motivo:', err.message);
    return false;
  }
}

async function checkPaginasRunt() {
  const browser = await chromium.connectOverCDP(CDP_URL);
  try {
    const context = browser.contexts()[0];
    const pages = context ? context.pages() : [];
    console.log(`ℹ️  ${pages.length} pestaña(s) abierta(s)`);
    pages.forEach((p, i) => console.log(`   [${i}] ${p.url()}`));

    const runt = pages.find(p => p.url().includes('runtpro.runt.gov.co'));
    if (!runt) {
      console.log('⚠️  No hay pestaña de RUNT abierta. El scraper abrirá una nueva.');
    } else {
      console.log('✅ Pestaña RUNT encontrada:', runt.url());
    }
    // No cerramos la conexión: es el Chrome del usuario.
  } catch (err) {
    console.log('⚠️  No se pudo inspeccionar las pestañas:', err.message);
  }
}

async function estadoPersona(documento) {
  const r = await pool.query(`
    SELECT
      numero_documento, tipo_documento, origen_registro,
      direccion_consultada, direccion_encontrada,
      error_consulta_direccion, fecha_consulta_direccion
    FROM persona_natural_propietario
    WHERE numero_documento = $1
    ORDER BY fecha_actualizacion DESC NULLS LAST
    LIMIT 1
  `, [documento]);

  if (r.rows.length === 0) {
    console.log('ℹ️  La persona NO existe en persona_natural_propietario.');
    return null;
  }

  const p = r.rows[0];
  console.log('ℹ️  Estado en BD:');
  console.log('    tipo_documento      :', p.tipo_documento);
  console.log('    origen_registro     :', p.origen_registro);
  console.log('    direccion_consultada:', p.direccion_consultada);
  console.log('    direccion_encontrada:', p.direccion_encontrada);
  console.log('    error_consulta      :', p.error_consulta_direccion);
  console.log('    ultima consulta     :', p.fecha_consulta_direccion);
  return p;
}

async function main() {
  const documento = String(process.argv[2] || '').trim();
  const tipoDocumento = String(process.argv[3] || 'CC').trim();

  if (!documento) {
    console.log('Uso: node scripts/diagDirecciones.js <numeroDocumento> [tipoDocumento]');
    process.exit(1);
  }

  console.log('══════════════════════════════════════════════════════════');
  console.log(`DIAGNÓSTICO direcciones PN — ${tipoDocumento} ${documento}`);
  console.log('══════════════════════════════════════════════════════════');

  if (!(await checkCDP())) {
    process.exit(1);
  }

  await checkPaginasRunt();

  console.log('\n── Estado ANTES de la consulta ──');
  await estadoPersona(documento).catch(err =>
    console.log('⚠️  No se pudo leer la BD:', err.message)
  );

  console.log('\n── Scrapeando RUNT ──');
  const inicio = Date.now();
  const resultado = await scrapeDireccionesPN({ tipoDocumento, numeroDocumento: documento });
  const total = Date.now() - inicio;

  console.log('\n── Resultado del scraper ──');
  console.log('  ok              :', resultado.ok);
  console.log('  noData          :', resultado.noData || false);
  console.log('  sessionExpired  :', resultado.sessionExpired || false);
  console.log('  error           :', resultado.error || '(ninguno)');
  console.log('  direcciones     :', resultado.direcciones ? resultado.direcciones.length : 0);
  console.log('  duración        :', `${(total / 1000).toFixed(1)}s`);

  if (resultado.direcciones && resultado.direcciones.length > 0) {
    const d = resultado.direcciones[0];
    console.log('\n  Primera dirección recibida:');
    console.log('    direccion  :', d.direccion || '(vacío)');
    console.log('    municipio  :', d.municipio || d.municipioDepartamento || '(vacío)');
    console.log('    campos     :', Object.keys(d).join(', '));
  }

  console.log('\n── Estado DESPUÉS de la consulta ──');
  await estadoPersona(documento).catch(err =>
    console.log('⚠️  No se pudo leer la BD:', err.message)
  );

  await pool.end().catch(() => {});
  process.exit(0);
}

main().catch(err => {
  console.error('\n💥 Error fatal del diagnóstico:', err.message);
  process.exit(1);
});
