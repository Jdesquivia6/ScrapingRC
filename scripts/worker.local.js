require('dotenv').config();
const axios = require('axios');

// Scrapers locales (el worker tiene el huellero USB conectado)
const { scrapeVehiculo } = require('../scraping/vehiculoScraper');
const { scrapeDatosVehiculo } = require('../scraping/datosVehiculoScraper');
const { scrapeDireccionesPN } = require('../scraping/runtScraper');
const { scrapeLiquidacionTramite } = require('../scraping/liquidacionScraper');

const API_BASE = process.env.WORKER_API_BASE || 'http://localhost:3000/api';
const TOKEN = process.env.WORKER_TOKEN || '';
const WORKER_EMAIL = process.env.WORKER_EMAIL || '';
const WORKER_PASSWORD = process.env.WORKER_PASSWORD || '';
const WORKER_NAME = process.env.WORKER_NAME || 'PC-LOCAL';
const MODULES = (process.env.WORKER_MODULES || 'consulta-placa,datos-vehiculo,personas-direcciones,liquidaciones')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS || 10000);
const HUELLA_VIVA = String(process.env.WORKER_HUELLA_VIVA || 'true').toLowerCase() === 'true';

let currentToken = TOKEN;

if (!TOKEN && (!WORKER_EMAIL || !WORKER_PASSWORD)) {
  throw new Error('WORKER_TOKEN o WORKER_EMAIL + WORKER_PASSWORD son obligatorios');
}

// Función para renovar token automáticamente
async function refreshToken() {
  try {
    // Si tenemos email y password, hacemos login para obtener nuevo token
    if (WORKER_EMAIL && WORKER_PASSWORD) {
      console.log(`[${new Date().toISOString()}] Renovando token automaticamente...`);
      
      const response = await axios.post(`${API_BASE}/auth/login`, {
        email: WORKER_EMAIL,
        password: WORKER_PASSWORD
      });
      
      if (response.data?.token) {
        currentToken = response.data.token;
        console.log(`[${new Date().toISOString()}] Token renovado correctamente`);
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error renovando token: ${error.message}`);
    return false;
  }
}

// Interceptor para manejar 401 y reintentar con nuevo token
const api = axios.create({
  baseURL: API_BASE,
  timeout: 30000
});

// Agregar interceptor de request
api.interceptors.request.use(
  (config) => {
    config.headers.Authorization = `Bearer ${currentToken}`;
    return config;
  },
  (error) => Promise.reject(error)
);

// Agregar interceptor de respuesta para manejar 401
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    
    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then(token => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return api(originalRequest);
          })
          .catch(err => Promise.reject(err));
      }
      
      originalRequest._retry = true;
      isRefreshing = true;
      
      try {
        const refreshed = await refreshToken();
        
        if (refreshed) {
          processQueue(null, currentToken);
          originalRequest.headers.Authorization = `Bearer ${currentToken}`;
          return api(originalRequest);
        } else {
          processQueue(new Error('No se pudo renovar el token'));
          return Promise.reject(error);
        }
      } catch (err) {
        processQueue(err);
        return Promise.reject(err);
      } finally {
        isRefreshing = false;
      }
    }
    
    return Promise.reject(error);
  }
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function heartbeat() {
  try {
    const response = await api.post('/worker-jobs/worker/heartbeat', {
      workerName: WORKER_NAME,
      modulosPermitidos: MODULES,
      huellaViva: HUELLA_VIVA
    });

    return response.data;
  } catch (error) {
    const status = error?.response?.status;
    const msg = error?.response?.data?.error || error.message;
    console.error(`[${new Date().toISOString()}] Error en heartbeat: status=${status} msg=${msg}`);
    throw error;
  }
}

async function tomarSiguiente() {
  try {
    const session = await api.get('/runt-session/estado');
    const sesionActiva = Boolean(session.data?.session?.activa && session.data?.session?.puedeConsultar);

    const response = await api.post('/worker-jobs/worker/tomar-siguiente', {
      workerName: WORKER_NAME,
      modulosPermitidos: MODULES,
      sesionActiva,
      huellaViva: HUELLA_VIVA
    });

    return response.data;
  } catch (error) {
    const status = error?.response?.status;
    const msg = error?.response?.data?.error || error.message;
    console.error(`[${new Date().toISOString()}] Error en tomarSiguiente: status=${status} msg=${msg}`);
    throw error;
  }
}

async function setJobEstado(jobId, estado, error = null) {
  await api.post(`/worker-jobs/${jobId}/worker/estado`, {
    estado,
    error
  });
}

async function setItemEstado(jobId, itemId, estado, resultado = null, error = null) {
  await api.post(`/worker-jobs/${jobId}/worker/item-estado`, {
    idItem: itemId,
    estado,
    resultado,
    error
  });
}

// Guardar resultado en DB del servidor
async function guardarResultadoScraping(jobId, itemId, modulo, resultado) {
  try {
    await api.post(`/worker-jobs/${jobId}/worker/guardar-resultado`, {
      idItem: itemId,
      modulo,
      resultado
    });
    console.log(`[worker] Resultado guardado en DB para ${modulo}`);
  } catch (error) {
    console.error(`[worker] Error guardando resultado: ${error.message}`);
  }
}

async function resolverItem(modulo, payload) {
  if (modulo === 'consulta-placa') {
    const placa = String(payload.placa || '').trim().toUpperCase();
    if (!placa) {
      return {
        estado: 'fallido',
        error: 'Payload invalido: placa es obligatoria'
      };
    }

    try {
      console.log(`[worker] Consultando placa ${placa} con huellero local...`);
      const result = await scrapeVehiculo({ placa });

      if (result.sessionExpired || result.error?.includes('sesion')) {
        return {
          estado: 'sesion_vencida',
          error: result.error || 'Sesion vencida durante consulta-placa'
        };
      }

      if (!result.ok) {
        return {
          estado: 'fallido',
          error: result.error || 'Fallo consulta-placa',
          resultado: result
        };
      }

      return {
        estado: 'exitoso',
        resultado: result
      };
    } catch (error) {
      return {
        estado: 'fallido',
        error: `Error scraping local: ${error.message}`
      };
    }
  }

  if (modulo === 'datos-vehiculo') {
    const placa = String(payload.placa || '').trim().toUpperCase();
    if (!placa) {
      return {
        estado: 'fallido',
        error: 'Payload invalido: placa es obligatoria'
      };
    }

    try {
      console.log(`[worker] Consultando datos vehiculo ${placa} con huellero local...`);
      const result = await scrapeDatosVehiculo({ placa });

      if (result.sessionExpired || result.error?.includes('sesion')) {
        return {
          estado: 'sesion_vencida',
          error: result.error || 'Sesion vencida durante datos-vehiculo'
        };
      }

      if (!result.ok) {
        return {
          estado: 'fallido',
          error: result.error || 'Fallo datos-vehiculo',
          resultado: result
        };
      }

      return {
        estado: 'exitoso',
        resultado: result
      };
    } catch (error) {
      return {
        estado: 'fallido',
        error: `Error scraping local: ${error.message}`
      };
    }
  }

  if (modulo === 'personas-direcciones') {
    const tipoDocumento = String(payload.tipoDocumento || '').trim();
    const numeroDocumento = String(payload.numeroDocumento || '').trim();

    if (!tipoDocumento || !numeroDocumento) {
      return {
        estado: 'fallido',
        error: 'Payload invalido: tipoDocumento y numeroDocumento son obligatorios'
      };
    }

    try {
      console.log(`[worker] Consultando direcciones ${tipoDocumento} ${numeroDocumento}...`);
      const result = await scrapeRunt(tipoDocumento, numeroDocumento);

      if (result.sessionExpired || result.error?.includes('sesion')) {
        return {
          estado: 'sesion_vencida',
          error: result.error || 'Sesion vencida durante personas-direcciones'
        };
      }

      if (result.noData) {
        return {
          estado: 'sin_informacion',
          resultado: result
        };
      }

      if (!result.ok) {
        return {
          estado: 'fallido',
          error: result.error || 'Fallo personas-direcciones',
          resultado: result
        };
      }

      return {
        estado: 'exitoso',
        resultado: result
      };
    } catch (error) {
      return {
        estado: 'fallido',
        error: `Error scraping local: ${error.message}`
      };
    }
  }

  if (modulo === 'liquidaciones' || modulo === 'liquidacion') {
    try {
      console.log(`[worker] Consultando liquidacion...`);
      const result = await scrapeLiquidacion(payload);

      if (!result.ok) {
        return {
          estado: 'fallido',
          error: result.error || 'Fallo liquidaciones',
          resultado: result
        };
      }

      return {
        estado: 'exitoso',
        resultado: result
      };
    } catch (error) {
      return {
        estado: 'fallido',
        error: `Error scraping local: ${error.message}`
      };
    }
  }

  return {
    estado: 'fallido',
    error: `Modulo no soportado por worker: ${modulo}`
  };
}

async function procesarJob(job, items) {
  for (const item of items) {
    try {
      await setItemEstado(job.id_job, item.id_item, 'procesando');
    } catch (err) {
      const st = err?.response?.status;
      const msg = err?.response?.data?.error || err.message;
      console.error(`[${new Date().toISOString()}] Error setItemEstado/procesando item ${item.id_item}: status=${st} msg=${msg}`);
    }

    try {
      const resultado = await resolverItem(job.modulo, item.payload || {});

      if (resultado.estado === 'exitoso') {
        await setItemEstado(job.id_job, item.id_item, 'exitoso', resultado.resultado, null);
        // Guardar en DB del servidor
        await guardarResultadoScraping(job.id_job, item.id_item, job.modulo, resultado.resultado);
      } else if (resultado.estado === 'sin_informacion') {
        await setItemEstado(job.id_job, item.id_item, 'sin_informacion', resultado.resultado || null, null);
        await guardarResultadoScraping(job.id_job, item.id_item, job.modulo, resultado.resultado || {});
      } else if (resultado.estado === 'sesion_vencida') {
        await setItemEstado(job.id_job, item.id_item, 'sesion_vencida', resultado.resultado || null, resultado.error || 'Sesion vencida');
        try { await setJobEstado(job.id_job, 'sesion_vencida', resultado.error || 'Sesion vencida durante procesamiento'); } catch (_) {}
        return;
      } else {
        await setItemEstado(job.id_job, item.id_item, 'fallido', null, resultado.error || 'Fallo del worker');
      }
    } catch (error) {
      const status = error?.response?.status;
      const message = error?.response?.data?.error || error.message;

      console.error(`[${new Date().toISOString()}] Error en item ${item.id_item}: status=${status} msg=${message}`);

      if (status === 409) {
        try { await setItemEstado(job.id_job, item.id_item, 'sesion_vencida', null, message); } catch (_) {}
        try { await setJobEstado(job.id_job, 'sesion_vencida', message); } catch (_) {}
        return;
      }

      try { await setItemEstado(job.id_job, item.id_item, 'fallido', null, message); } catch (_) {}
    }

    await sleep(250);
  }
}

async function ciclo() {
  try {
    const hb = await heartbeat();

    if (!hb.elegible) {
      const msg = `[${new Date().toISOString()}] Worker no elegible | sesion=${hb.reglas?.sesionActiva} huella=${hb.reglas?.huellaViva}`;
      console.log(msg);
      return;
    }

    const take = await tomarSiguiente();

    if (!take.job) {
      console.log(`[${new Date().toISOString()}] Sin jobs pendientes`);
      return;
    }

    console.log(`[${new Date().toISOString()}] Procesando job ${take.job.id_job} (${take.job.modulo}) items=${take.items.length}`);
    const jobEstado = take.job.estado;
    if (jobEstado === 'procesando' || jobEstado === 'pendiente') {
      await procesarJob(take.job, take.items || []);
    } else {
      console.log(`[${new Date().toISOString()}] Job ${take.job.id_job} ya no es procesable (estado=${jobEstado}), reinsertando a pendiente`);
      await api.post(`/worker-jobs/${take.job.id_job}/worker/estado`, { estado: 'pendiente' });
    }
    console.log(`[${new Date().toISOString()}] Job ${take.job.id_job} finalizado`);
  } catch (error) {
    const status = error?.response?.status;
    const msg = error?.response?.data?.error || error.message;
    console.error(`[${new Date().toISOString()}] Error en ciclo worker: status=${status} msg=${msg}`);
  }
}

async function main() {
  console.log(`Worker ${WORKER_NAME} iniciado | modulos=${MODULES.join(',')} | intervalo=${INTERVAL_MS}ms`);
  await ciclo();
  setInterval(ciclo, INTERVAL_MS);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
