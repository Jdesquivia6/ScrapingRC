const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: '84.247.165.214',
  database: 'Automatizacion-RUNT-PRO',
  password: '4UT0M4T1Z4C10N1023*-',
  port: 5432,
  // El timezone se fija en el arranque del backend (mensaje de startup) en vez de
  // con un SET TIME ZONE dentro de pool.on('connect'). Esa query no se esperaba:
  // pg repartia el cliente mientras aun corría y dos queries quedaban en vuelo sobre
  // el mismo cliente -> DeprecationWarning "client is already executing a query" de pg@9
  // y clientes en estado inconsistente.
  options: '-c TimeZone=America/Bogota',
  // Postgres o la infraestructura de red cortan la TCP sin avisar y, si nadie
  // toma el error, el cliente queda zombie esperando para siempre.
  connectionTimeoutMillis: 10000,
});

// Este handler es obligatorio. Sin él, el 'error' de un cliente inactivo del pool
// se emite sin listener, Node lo trata como excepcion no capturada y mata el proceso.
// Sintoma visto en produccion:
//   Error: Connection terminated unexpectedly
//   Emitted 'error' event on Client instance at: Client._handleErrorEvent
//   -> el backend se cae, el worker deja de recibir heartbeat y todo se detiene.
pool.on('error', (err) => {
  console.error('[db] Cliente del pool desconectado (no fatal):', err.message);
});

module.exports = pool;
