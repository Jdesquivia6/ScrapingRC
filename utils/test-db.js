const pool = require('./db');

async function testDB() {
  try {
    // 🔹 Insertar una placa
    await pool.query(`
      INSERT INTO consultas_placas (placa, estado_consulta)
      VALUES ($1, $2)
      ON CONFLICT (placa) DO NOTHING
    `, ['ABC123', false]);

    console.log('✅ Placa insertada');

    // 🔹 Consultar lo que hay
    const res = await pool.query(`
      SELECT * FROM consultas_placas
    `);

    console.log('📦 Datos en tabla:', res.rows);

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    process.exit();
  }
}

testDB();