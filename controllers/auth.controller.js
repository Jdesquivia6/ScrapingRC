const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../utils/db');
const crypto = require('crypto');
const { enviarCorreo } = require('../utils/mailer');

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const userResult = await pool.query(`
      SELECT *
      FROM usuarios
      WHERE email = $1
    `, [email]);

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        ok: false,
        error: 'Usuario no encontrado'
      });
    }

    const user = userResult.rows[0];

    if (!user.activo) {
      return res.status(403).json({
        ok: false,
        error: 'Usuario desactivado'
      });
    }

    const validPassword = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        ok: false,
        error: 'Contraseña inválida'
      });
    }

    const modulesResult = await pool.query(`
      SELECT m.codigo
      FROM usuario_modulos um
      INNER JOIN modulos m
        ON m.id_modulo = um.fk_modulo
      WHERE um.fk_usuario = $1
    `, [user.id_usuario]);

    const modulos = modulesResult.rows.map(r => r.codigo);

    const token = jwt.sign({
      id_usuario: user.id_usuario,
      email: user.email,
      rol: user.rol,
      modulos
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '12h'
    });

    return res.json({
      ok: true,
      token,
      user: {
        id_usuario: user.id_usuario,
        nombre: user.nombre,
        email: user.email,
        rol: user.rol,
        modulos,
        debe_cambiar_password: user.debe_cambiar_password
      }
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

function generarPasswordTemporal() {
  return crypto.randomBytes(5).toString('hex') + '*A1';
}

exports.recuperarPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: 'El correo es obligatorio'
      });
    }

    const userResult = await pool.query(`
      SELECT id_usuario, nombre, email
      FROM usuarios
      WHERE email = $1
        AND activo = true
    `, [email.toLowerCase().trim()]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'No existe un usuario activo con ese correo'
      });
    }

    const usuario = userResult.rows[0];

    const nuevaPassword = generarPasswordTemporal();
    const passwordHash = await bcrypt.hash(nuevaPassword, 10);

    await pool.query(`
      UPDATE usuarios
      SET password_hash = $1,
          debe_cambiar_password = true
      WHERE id_usuario = $2
    `, [passwordHash, usuario.id_usuario]);

    await enviarCorreo({
      to: usuario.email,
      subject: 'Recuperación de contraseña - App RUNT',
      html: `
        <div style="font-family: Arial, sans-serif; color: #111827;">
          <h2>Recuperación de contraseña</h2>
          <p>Hola <b>${usuario.nombre}</b>,</p>
          <p>Se generó una nueva contraseña temporal para tu cuenta.</p>

          <div style="background:#f1f5f9;padding:16px;border-radius:12px;margin:16px 0;">
            <p style="margin:0;font-size:14px;color:#475569;">Nueva contraseña:</p>
            <h3 style="margin:8px 0 0;font-size:22px;color:#2563eb;">
              ${nuevaPassword}
            </h3>
          </div>

          <p>Te recomendamos iniciar sesión y cambiarla inmediatamente.</p>
          <p style="font-size:12px;color:#64748b;">
            Si no solicitaste este cambio, contacta al administrador.
          </p>
        </div>
      `
    });

    return res.json({
      ok: true,
      message: 'Se envió una nueva contraseña al correo registrado'
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};

exports.cambiarMiPassword = async (req, res) => {
  try {
    const { passwordActual, nuevaPassword } = req.body;
    const idUsuario = req.user.id_usuario;

    if (!passwordActual || !nuevaPassword) {
      return res.status(400).json({
        ok: false,
        error: 'passwordActual y nuevaPassword son obligatorios'
      });
    }

    if (nuevaPassword.length < 6) {
      return res.status(400).json({
        ok: false,
        error: 'La nueva contraseña debe tener mínimo 6 caracteres'
      });
    }

    const userResult = await pool.query(`
      SELECT password_hash
      FROM usuarios
      WHERE id_usuario = $1
    `, [idUsuario]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Usuario no encontrado'
      });
    }

    const user = userResult.rows[0];

    const validPassword = await bcrypt.compare(
      passwordActual,
      user.password_hash
    );

    if (!validPassword) {
      return res.status(401).json({
        ok: false,
        error: 'La contraseña actual no es correcta'
      });
    }

    const nuevoHash = await bcrypt.hash(nuevaPassword, 10);

    await pool.query(`
      UPDATE usuarios
      SET password_hash = $1,
          debe_cambiar_password = false
      WHERE id_usuario = $2
    `, [nuevoHash, idUsuario]);

    return res.json({
      ok: true,
      message: 'Contraseña actualizada correctamente'
    });

  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
};