const pool = require('./db');

const SESSION_DURATION_MINUTES = 60;
const SAFETY_MARGIN_MINUTES = 10;
const MINUTES_PER_PLATE = 1.2;

// ============================================
// FUNCIONES DE BASE DE DATOS
// ============================================

async function obtenerSesionDB() {
  try {
    const result = await pool.query(
      'SELECT session_started_at FROM runt_sesion ORDER BY id DESC LIMIT 1'
    );
    return result.rows[0]?.session_started_at || null;
  } catch (error) {
    console.error('[runtSession] Error consultando sesión en DB:', error.message);
    return null;
  }
}

async function guardarSesionDB(sessionStartedAt) {
  try {
    await pool.query(
      'INSERT INTO runt_sesion (session_started_at) VALUES ($1)',
      [sessionStartedAt]
    );
    return true;
  } catch (error) {
    console.error('[runtSession] Error guardando sesión en DB:', error.message);
    return false;
  }
}

// ============================================
// FUNCIONES PÚBLICAS
// ============================================

async function iniciarSesionRunt() {
  const sessionStartedAt = new Date();
  await guardarSesionDB(sessionStartedAt);
  return sessionStartedAt;
}

async function reiniciarSesionRunt() {
  const sessionStartedAt = new Date();
  await guardarSesionDB(sessionStartedAt);
  return sessionStartedAt;
}

async function obtenerEstadoSesionRunt() {
  const sessionStartedAt = await obtenerSesionDB();

  if (!sessionStartedAt) {
    return {
      iniciada: false,
      activa: false,
      puedeConsultar: false,
      minutosRestantes: 0,
      capacidadSegura: 0,
      mensaje: 'No se ha registrado inicio de sesión RUNT'
    };
  }

  const ahora = new Date();
  const minutosTranscurridos = Math.floor(
    (ahora.getTime() - new Date(sessionStartedAt).getTime()) / 60000
  );

  const minutosRestantes = Math.max(
    SESSION_DURATION_MINUTES - minutosTranscurridos,
    0
  );

  const activa = minutosRestantes > 0;
  const puedeConsultar = minutosRestantes > SAFETY_MARGIN_MINUTES;

  const capacidadSegura = puedeConsultar
    ? Math.max(
        Math.floor((minutosRestantes - SAFETY_MARGIN_MINUTES) / MINUTES_PER_PLATE),
        0
      )
    : 0;

  return {
    iniciada: true,
    activa,
    puedeConsultar,
    sessionStartedAt,
    minutosTranscurridos,
    minutosRestantes,
    capacidadSegura,
    mensaje: activa
      ? `Quedan ${minutosRestantes} minutos de sesión RUNT`
      : 'La sesión RUNT ya venció'
  };
}

module.exports = {
  iniciarSesionRunt,
  reiniciarSesionRunt,
  obtenerEstadoSesionRunt
};