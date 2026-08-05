const SESSION_DURATION_MINUTES = 60;
const SAFETY_MARGIN_MINUTES = 10;
const MINUTES_PER_PLATE = 1.2;

// ============================================
// SESIÓN LOCAL POR INSTANCIA DE BACKEND
// ============================================
// Cada PC que corre su propio backend tiene su propia sesión RUNT en memoria.
// Esto evita que varias PCs compartan la misma sesión en la base de datos.

let sesionLocal = null;

async function obtenerSesionDB() {
  return sesionLocal;
}

async function guardarSesionDB(sessionStartedAt) {
  sesionLocal = sessionStartedAt;
  return true;
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

async function simularMinutosRestantes(minutos) {
  if (typeof minutos !== 'number' || minutos < 0 || minutos > 120) {
    throw new Error('minutos debe ser un numero entre 0 y 120');
  }
  const minutosTranscurridos = SESSION_DURATION_MINUTES - minutos;
  const sessionStartedAt = new Date(Date.now() - minutosTranscurridos * 60000);
  await guardarSesionDB(sessionStartedAt);
  return sessionStartedAt;
}

async function limpiarSesionTest() {
  sesionLocal = null;
  return true;
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
  obtenerEstadoSesionRunt,
  simularMinutosRestantes,
  limpiarSesionTest
};