const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: '84.247.165.214',
  database: 'Automatizacion-RUNT-PRO',
  password: '4UT0M4T1Z4C10N1023*-',
  port: 5432,
});

module.exports = pool;