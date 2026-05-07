const bcrypt = require('bcryptjs');
const pool = require('../utils/db');

exports.listarUsuarios = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id_usuario,
        u.nombre,
        u.email,
        u.rol,
        u.activo,
        u.created_at,
        COALESCE(
          json_agg(m.codigo) FILTER (WHERE m.codigo IS NOT NULL),
          '[]'
        ) AS modulos
      FROM usuarios u
      LEFT JOIN usuario_modulos um ON um.fk_usuario = u.id_usuario
      LEFT JOIN modulos m ON m.id_modulo = um.fk_modulo
      GROUP BY u.id_usuario
      ORDER BY u.created_at DESC
    `);

    return res.json({
      ok: true,
      results: result.rows
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};

exports.crearUsuario = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      nombre,
      email,
      password,
      rol = 'operario',
      modulos = []
    } = req.body;

    if (!nombre || !email || !password) {
      return res.status(400).json({
        ok: false,
        error: 'nombre, email y password son obligatorios'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await client.query('BEGIN');

    const userResult = await client.query(`
      INSERT INTO usuarios (
        nombre,
        email,
        password_hash,
        rol,
        activo
      ) VALUES ($1,$2,$3,$4,true)
      RETURNING id_usuario, nombre, email, rol, activo
    `, [
      nombre,
      email.toLowerCase().trim(),
      passwordHash,
      rol
    ]);

    const usuario = userResult.rows[0];

    if (rol !== 'administrador' && modulos.length > 0) {
      const modulosResult = await client.query(`
        SELECT id_modulo, codigo
        FROM modulos
        WHERE codigo = ANY($1)
      `, [modulos]);

      for (const modulo of modulosResult.rows) {
        await client.query(`
          INSERT INTO usuario_modulos (
            fk_usuario,
            fk_modulo
          ) VALUES ($1,$2)
        `, [
          usuario.id_usuario,
          modulo.id_modulo
        ]);
      }
    }

    await client.query('COMMIT');

    return res.json({
      ok: true,
      usuario
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  } finally {
    client.release();
  }
};

exports.actualizarUsuario = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const {
      nombre,
      email,
      rol,
      activo,
      modulos = []
    } = req.body;

    await client.query('BEGIN');

    await client.query(`
      UPDATE usuarios
      SET 
        nombre = COALESCE($1, nombre),
        email = COALESCE($2, email),
        rol = COALESCE($3, rol),
        activo = COALESCE($4, activo)
      WHERE id_usuario = $5
    `, [
      nombre || null,
      email ? email.toLowerCase().trim() : null,
      rol || null,
      typeof activo === 'boolean' ? activo : null,
      id
    ]);

    await client.query(`
      DELETE FROM usuario_modulos
      WHERE fk_usuario = $1
    `, [id]);

    if (rol !== 'administrador' && modulos.length > 0) {
      const modulosResult = await client.query(`
        SELECT id_modulo
        FROM modulos
        WHERE codigo = ANY($1)
      `, [modulos]);

      for (const modulo of modulosResult.rows) {
        await client.query(`
          INSERT INTO usuario_modulos (
            fk_usuario,
            fk_modulo
          ) VALUES ($1,$2)
        `, [
          id,
          modulo.id_modulo
        ]);
      }
    }

    await client.query('COMMIT');

    return res.json({
      ok: true,
      message: 'Usuario actualizado correctamente'
    });

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ ok: false, error: error.message });
  } finally {
    client.release();
  }
};

exports.cambiarPasswordUsuario = async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({
        ok: false,
        error: 'La contraseña debe tener mínimo 6 caracteres'
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await pool.query(`
      UPDATE usuarios
      SET password_hash = $1
      WHERE id_usuario = $2
    `, [passwordHash, id]);

    return res.json({
      ok: true,
      message: 'Contraseña actualizada correctamente'
    });

  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};

exports.listarModulos = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id_modulo, codigo, nombre
      FROM modulos
      ORDER BY nombre ASC
    `);

    return res.json({
      ok: true,
      results: result.rows
    });

  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
};