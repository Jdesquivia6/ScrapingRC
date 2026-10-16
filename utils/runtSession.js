const fs = require('fs');
const path = require('path');

const SESSION_DURATION_MINUTES = 60;
const SAFETY_MARGIN_MINUTES = 10;
const MINUTES_PER_PLATE = 1.2;

// ============================================
// SESIÓN LOCAL PERSISTIDA EN DISCO
// ============================================
// Cada PC que corre su propio backend tiene su propia sesión RUNT.
// Se persiste en sesion-runt.json (NO en memoria) para que sobreviva
// a reinicios del backend, cierres del script "iniciar chrome", etc.

const SESION_FILE = path.join(__dirname, '..', 'sesion-runt.json');

function leerSesion() {
  try {
    if (!fs.existsSync(SESION_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(SESION_FILE, 'utf8'));
    return data?.sessionStartedAt ? new Date(data.sessionStartedAt) : null;
  } catch (err) {
    console.warn('No se pudo leer sesion-runt.json:', err.message);
    return null;
  }
}

function escribirSesion(sessionStartedAt) {
  try {
    fs.writeFileSync(SESION_FILE, JSON.stringify({
      sessionStartedAt: sessionStartedAt.toISOString()
    }));
    return true;
  } catch (err) {
    console.error('No se pudo escribir sesion-runt.json:', err.message);
    return false;
  }
}

function limpiarSesionArchivo() {
  try {
    if (fs.existsSync(SESION_FILE)) fs.unlinkSync(SESION_FILE);
  } catch (err) {
    console.warn('No se pudo limpiar sesion-runt.json:', err.message);
  }
}

async function obtenerSesionDB() {
  const sesion = leerSesion();
  if (!sesion) return null;
  const minutosTranscurridos = (Date.now() - sesion.getTime()) / 60000;
  if (minutosTranscurridos >= SESSION_DURATION_MINUTES) {
    limpiarSesionArchivo();
    return null;
  }
  return sesion;
}

async function guardarSesionDB(sessionStartedAt) {
  escribirSesion(sessionStartedAt);
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
  limpiarSesionArchivo();
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