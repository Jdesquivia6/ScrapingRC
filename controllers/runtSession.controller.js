
const pool = require("../utils/db");
const {
  iniciarSesionRunt,
  reiniciarSesionRunt,
  obtenerEstadoSesionRunt,
  simularMinutosRestantes,
  limpiarSesionTest
} = require("../utils/runtSession");

// ======================================================
// REANUDAR JOBS CUANDO SE RENUEVA LA SESIÓN
// Se conserva la lógica original: sesión RUNT por PC.
// ======================================================

async function reanudarJobsSesionVencida() {
  try {
    const result = await pool.query(`
      UPDATE worker_jobs
      SET estado = 'pendiente',
          error = NULL
      WHERE estado = 'sesion_vencida'
        AND modulo IN ('ubicabilidad-personas', 'personas-direcciones')
      RETURNING id_job
    `);

    if (result.rowCount > 0) {
      console.log(
        `[runtSession] ${result.rowCount} jobs sesion_vencida reseteados a 'pendiente'`
      );
    }

    return result.rowCount;
  } catch (err) {
    console.error(
      "[runtSession] Error al reanudar jobs sesion_vencida:",
      err.message
    );
    return 0;
  }
}

// ======================================================
// UTILIDADES PARA LA VENTANA HTML
// ======================================================

const escaparHTML = valor =>
  String(valor ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);

const jsonSeguro = valor =>
  JSON.stringify(valor)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

// ======================================================
// DISEÑO CORPORATIVO AUTOCORE - VENTANA RUNT
// ======================================================

function generarPaginaSesion({ exito, session = null, jobsReanudados = 0 }) {
  const minutos = Number.isFinite(Number(session?.minutosRestantes))
    ? Math.max(0, Number(session.minutosRestantes))
    : 0;

  const jobs = Number.isFinite(Number(jobsReanudados))
    ? Math.max(0, Math.trunc(Number(jobsReanudados)))
    : 0;

  const titulo = exito
    ? "Sesión RUNT renovada"
    : "No se pudo renovar la sesión";

  const descripcion = exito
    ? "El registro se completó correctamente. Puedes continuar trabajando."
    : "La operación no pudo completarse. Intenta nuevamente.";

  const mensajeJobs = jobs > 0
    ? `${jobs} trabajo(s) en cola reactivado(s) automáticamente.`
    : "No había trabajos pendientes de reanudar.";

  const payload = exito
    ? jsonSeguro({ ok: true, session, jobsReanudados: jobs })
    : "null";

  const icono = exito
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
         <circle cx="12" cy="12" r="10"/>
         <path d="m8 12 3 3 5-6"/>
       </svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
         <circle cx="12" cy="12" r="10"/>
         <path d="M12 7v6M12 17h.01"/>
       </svg>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escaparHTML(titulo)} | AutoCore</title>

  <style>
    * { box-sizing: border-box; }

    html, body {
      min-height: 100%;
      margin: 0;
    }

    body {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 14px;
      background:
        radial-gradient(circle at 95% 5%, rgba(0,171,228,.18), transparent 45%),
        linear-gradient(145deg, #081f3a, #0b2947);
      color: #0f172a;
      font-family: Inter, system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
    }

    .card {
      width: 100%;
      max-width: 440px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 18px;
      background: #fff;
      box-shadow: 0 18px 55px rgba(0,0,0,.25);
      animation: entrada .3s ease-out;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 12px 17px;
      border-bottom: 1px solid #e9eff5;
    }

    .logo {
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      flex-shrink: 0;
      border-radius: 9px;
      background: linear-gradient(135deg, #00abe4, #0095c5);
      color: white;
      font-size: 12px;
      font-weight: 800;
    }

    .brand-name {
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -.5px;
    }

    .brand-name span { color: #00abe4; }

    .tag {
      margin-left: auto;
      color: #64748b;
      font-size: 10px;
      font-weight: 700;
    }

    .content {
      padding: 18px 20px 15px;
      text-align: center;
    }

    .status-icon {
      display: grid;
      place-items: center;
      width: 52px;
      height: 52px;
      margin: 0 auto 11px;
      border-radius: 16px;
      background: ${exito ? "#e8f9f0" : "#fff0f0"};
      color: ${exito ? "#059669" : "#dc2626"};
    }

    .status-icon svg {
      width: 29px;
      height: 29px;
    }

    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.3;
      font-weight: 800;
      letter-spacing: -.4px;
    }

    .description {
      margin: 7px 0 0;
      color: #64748b;
      font-size: 12px;
      line-height: 1.6;
    }

    .metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 9px;
      margin-top: 15px;
      text-align: left;
    }

    .metric {
      padding: 11px 12px;
      border: 1px solid #e5edf5;
      border-radius: 12px;
      background: #f8fbfd;
    }

    .metric-label {
      display: block;
      margin-bottom: 4px;
      color: #64748b;
      font-size: 10px;
    }

    .metric-value {
      color: #0f172a;
      font-size: 23px;
      font-weight: 800;
    }

    .metric-value.green { color: #059669; }

    .unit {
      margin-left: 3px;
      font-size: 11px;
      font-weight: 600;
    }

    .notice {
      margin-top: 12px;
      padding: 10px;
      border: 1px solid ${exito ? "#d1fae5" : "#fee2e2"};
      border-radius: 10px;
      background: ${exito ? "#ecfdf5" : "#fef2f2"};
      color: ${exito ? "#047857" : "#b91c1c"};
      font-size: 11px;
      line-height: 1.6;
    }

    .actions { margin-top: 14px; }

    button {
      width: 100%;
      min-height: 44px;
      border: 0;
      border-radius: 11px;
      background: #00abe4;
      color: white;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
      touch-action: manipulation;
      transition: background .2s;
    }

    button:hover { background: #0095c5; }
    button:focus-visible { outline: 3px solid #7dd3fc; outline-offset: 2px; }

    .footer {
      padding: 11px 15px;
      border-top: 1px solid #e9eff5;
      background: #f8fafc;
      color: #94a3b8;
      font-size: 10px;
      text-align: center;
    }

    .progress {
      height: 3px;
      background: #e5edf5;
    }

    .progress-bar {
      height: 100%;
      background: #00abe4;
      transform-origin: left;
      animation: countdown 4s linear forwards;
    }

    @keyframes entrada {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes countdown {
      from { transform: scaleX(1); }
      to { transform: scaleX(0); }
    }

    @media (max-height: 380px) {
      body { align-items: flex-start; padding: 8px; }
      .brand { padding: 8px 13px; }
      .content { padding: 10px 13px; }
      .status-icon {
        width: 36px;
        height: 36px;
        margin-bottom: 6px;
        border-radius: 10px;
      }
      .status-icon svg { width: 21px; height: 21px; }
      h1 { font-size: 16px; }
      .description { margin-top: 3px; }
      .metrics { margin-top: 8px; }
      .metric { padding: 7px; }
      .metric-value { font-size: 17px; }
      .notice { margin-top: 7px; padding: 7px; }
      .actions { margin-top: 8px; }
      button { min-height: 38px; }
      .footer { padding: 7px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .card, .progress-bar { animation: none; }
    }
  </style>
</head>

<body>
  <div class="card">
    <div class="brand">
      <div class="logo">AC</div>
      <div class="brand-name">Auto<span>Core</span></div>
      <div class="tag">SESIÓN RUNT</div>
    </div>

    <div class="content">
      <div class="status-icon">${icono}</div>

      <h1>${escaparHTML(titulo)}</h1>
      <p class="description">${escaparHTML(descripcion)}</p>

      ${exito ? `
        <div class="metrics">
          <div class="metric">
            <span class="metric-label">Tiempo disponible</span>
            <span class="metric-value green">
              ${escaparHTML(minutos)}<span class="unit">min</span>
            </span>
          </div>

          <div class="metric">
            <span class="metric-label">Trabajos reanudados</span>
            <span class="metric-value">${escaparHTML(jobs)}</span>
          </div>
        </div>

        <div class="notice">${escaparHTML(mensajeJobs)}</div>
      ` : `
        <div class="notice">
          Verifica la conexión e inténtalo nuevamente.
          Si el problema continúa, contacta al administrador.
        </div>
      `}

      <div class="actions">
        <button type="button" onclick="window.close()">
          Cerrar ventana
        </button>
      </div>
    </div>

    <div class="footer">
      ${exito
        ? "Esta ventana se cerrará automáticamente en 4 segundos."
        : "Puedes cerrar esta ventana e intentar nuevamente."
      }
    </div>

    ${exito
      ? '<div class="progress"><div class="progress-bar"></div></div>'
      : ""
    }
  </div>

  ${exito ? `
    <script>
      if (window.opener) {
        window.opener.postMessage(
          {
            type: "runt-session-iniciada",
            payload: ${payload}
          },
          "*"
        );
      }

      setTimeout(function () {
        window.close();
      }, 4000);
    <\/script>
  ` : ""}
</body>
</html>`;
}

// ======================================================
// POST /iniciar - API ORIGINAL
// ======================================================

exports.iniciarSesion = async (req, res) => {
  await iniciarSesionRunt();
  const jobsReanudados = await reanudarJobsSesionVencida();
  const session = await obtenerEstadoSesionRunt();

  return res.json({
    ok: true,
    message: jobsReanudados > 0
      ? `Sesion RUNT registrada. ${jobsReanudados} trabajo(s) sesion_vencida reanudado(s).`
      : "Sesión RUNT registrada correctamente",
    session,
    jobsReanudados
  });
};

// ======================================================
// GET /iniciar - VENTANA CORPORATIVA
// ======================================================

exports.iniciarSesionPage = async (req, res) => {
  try {
    await iniciarSesionRunt();
    const jobsReanudados = await reanudarJobsSesionVencida();
    const session = await obtenerEstadoSesionRunt();

    res.setHeader("Content-Type", "text/html; charset=utf-8");

    return res.send(
      generarPaginaSesion({
        exito: true,
        session,
        jobsReanudados
      })
    );
  } catch (err) {
    console.error("[runtSession] Error al renovar sesión RUNT:", err.message);

    res.setHeader("Content-Type", "text/html; charset=utf-8");

    return res.status(500).send(
      generarPaginaSesion({ exito: false })
    );
  }
};

// ======================================================
// POST /reiniciar - API ORIGINAL
// ======================================================

exports.reiniciarSesion = async (req, res) => {
  await reiniciarSesionRunt();
  const jobsReanudados = await reanudarJobsSesionVencida();
  const session = await obtenerEstadoSesionRunt();

  return res.json({
    ok: true,
    message: jobsReanudados > 0
      ? `Sesion RUNT reiniciada. ${jobsReanudados} trabajo(s) sesion_vencida reanudado(s).`
      : "Sesión RUNT reiniciada correctamente",
    session,
    jobsReanudados
  });
};

// ======================================================
// GET /estado - API ORIGINAL
// ======================================================

exports.estadoSesion = async (req, res) => {
  const session = await obtenerEstadoSesionRunt();

  return res.json({
    ok: true,
    session
  });
};

// ======================================================
// POST /test/simular - API ORIGINAL
// ======================================================

exports.simularTest = async (req, res) => {
  try {
    const { minutos, limpiar } = req.body || {};

    if (limpiar === true) {
      await limpiarSesionTest();
      const session = await obtenerEstadoSesionRunt();

      return res.json({
        ok: true,
        message: "Sesion limpiada (TEST)",
        session
      });
    }

    const mins = Number(minutos);

    if (Number.isNaN(mins)) {
      return res.status(400).json({
        ok: false,
        error: "minutos es obligatorio (numero entre 0 y 120) o limpiar: true"
      });
    }

    await simularMinutosRestantes(mins);
    const session = await obtenerEstadoSesionRunt();

    return res.json({
      ok: true,
      message: `Sesion simulada a ${mins} minutos restantes (TEST)`,
      session
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
};
