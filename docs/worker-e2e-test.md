# Worker Jobs - Prueba End-to-End

## 1) Pre-requisitos

- Backend corriendo en `http://localhost:3000`
- Tablas creadas: `worker_jobs`, `worker_job_items`
- Usuario activo con token JWT
- Sesion RUNT iniciada en backend

Iniciar sesion RUNT:

```bash
curl -X POST http://localhost:3000/api/runt-session/iniciar
```

## 2) Crear un job (ejemplo consulta-placa)

```bash
curl -X POST http://localhost:3000/api/worker-jobs \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{
    "modulo": "consulta-placa",
    "workerName": "PC-JOSE",
    "items": [
      {"placa":"ABC123"},
      {"placa":"XYZ987"}
    ]
  }'
```

Guarda el `id_job` de la respuesta.

## 3) Iniciar worker local

En PowerShell:

```powershell
$env:WORKER_TOKEN="TU_TOKEN"
$env:WORKER_NAME="PC-JOSE"
$env:WORKER_MODULES="consulta-placa,datos-vehiculo,personas-direcciones,liquidaciones"
$env:WORKER_INTERVAL_MS="10000"
$env:WORKER_HUELLA_VIVA="true"
npm run worker:local
```

## 4) Verificar cola y progreso

Listar jobs:

```bash
curl -H "Authorization: Bearer TU_TOKEN" \
  http://localhost:3000/api/worker-jobs
```

Ver progreso por job:

```bash
curl -H "Authorization: Bearer TU_TOKEN" \
  http://localhost:3000/api/worker-jobs/ID_JOB/progreso
```

Ver detalle con items:

```bash
curl -H "Authorization: Bearer TU_TOKEN" \
  http://localhost:3000/api/worker-jobs/ID_JOB
```

## 5) Probar control operativo

Cancelar job:

```bash
curl -X POST -H "Authorization: Bearer TU_TOKEN" \
  http://localhost:3000/api/worker-jobs/ID_JOB/cancelar
```

Reintentar fallidos:

```bash
curl -X POST -H "Authorization: Bearer TU_TOKEN" \
  http://localhost:3000/api/worker-jobs/ID_JOB/reintentar-fallidos
```

Catalogo de estados:

```bash
curl -H "Authorization: Bearer TU_TOKEN" \
  http://localhost:3000/api/worker-jobs/catalogos/estados
```

## 6) Endpoints worker

- `POST /api/worker-jobs/worker/heartbeat`
- `POST /api/worker-jobs/worker/tomar-siguiente`
- `POST /api/worker-jobs/:id/worker/estado`
- `POST /api/worker-jobs/:id/worker/item-estado`

## 7) Casos de validacion

- Si `WORKER_HUELLA_VIVA=false`, el worker no toma jobs.
- Si sesion RUNT vence (`/api/runt-session/estado`), `heartbeat` devuelve `elegible=false`.
- Si el usuario no tiene permiso de modulo, no puede crear ni tomar jobs de ese modulo.
- El worker ejecuta scraping real usando endpoints de backend por modulo:
  - `consulta-placa` -> `/api/vehiculos/procesar-batch`
  - `datos-vehiculo` -> `/api/datos-vehiculo/procesar-batch`
  - `personas-direcciones` -> `/api/personas/direcciones/consultar-direcciones-pn`
  - `liquidaciones` -> `/api/liquidacion/consultar-liquidacion`
