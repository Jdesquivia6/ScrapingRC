const bcrypt = require('bcryptjs');
const pool = require('../utils/db');

async function createAdmin() {
  try {
    const password = await bcrypt.hash('Admin123*', 10);

    await pool.query(`
      INSERT INTO usuarios (
        nombre,
        email,
        password_hash,
        rol
      )
      VALUES ($1,$2,$3,$4)
    `, [
      'Administrador',
      'admin@runt.com',
      password,
      'administrador'
    ]);

    console.log('✅ Admin creado');

    process.exit();

  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

createAdmin();