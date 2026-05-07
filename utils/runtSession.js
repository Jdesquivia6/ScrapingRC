let sessionStartedAt = null;

const SESSION_DURATION_MINUTES = 60;
const SAFETY_MARGIN_MINUTES = 10;
const MINUTES_PER_PLATE = 1.2;

function iniciarSesionRunt() {
  sessionStartedAt = new Date();
}

function reiniciarSesionRunt() {
  sessionStartedAt = new Date();
}

function obtenerEstadoSesionRunt() {
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
    (ahora.getTime() - sessionStartedAt.getTime()) / 60000
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