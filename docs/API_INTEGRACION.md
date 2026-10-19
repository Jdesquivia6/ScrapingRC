# API de Integración — Ubicabilidad de Personas

> Documento técnico para los equipos que van a conectar sus sistemas
> (Contravenciones, Cobro Coactivo, Ventanilla, Civitrans, etc.)
> al módulo **Ubicabilidad de Personas**.

| | |
|---|---|
| **Base URL (producción)** | `http://84.247.165.214:3000/api/v1/integraciones` |
| **Base URL (desarrollo)** | `http://localhost:3000/api/v1/integraciones` |
| **Autenticación** | Header `X-API-Key` |
| **Formato** | `application/json` |
| **Límite de body** | 5 MB |
| **Rate limit** | 120 req/min por cliente |

---

## 1. Alcance de la API

### ✅ Lo que SÍ hace

- **Insertar** personas en masa en `persona_natural_propietario` con
  `origen_registro = 'API_<SU_CODIGO>'`.
- **Consultar** el estado de avance y los resultados de las personas
  insertadas (polling).

### ❌ Lo que NO hace

| No hace esto | Por qué |
|---|---|
| Crea trabajos (`worker_jobs`) | El job lo decide y lo crea el **funcionario autenticado** en el panel web |
| Consulta RUNT / biometría | Eso lo hace el **worker** interno, con sesión de usuario |
| Usa la sesión biométrica | La API no tiene acceso a la sesión RUNT |
| Modifica o borra personas existentes | Solo inserta y consulta |
| Envía webhooks / callbacks | Por ahora solo **polling** |

**Regla de oro:** los sistemas externos **solo insertan personas**. El resto
del proceso lo dispara un humano desde el panel.

---

## 2. Autenticación (X-API-Key)

### Encabezado obligatorio

```http
X-API-Key: TU_API_KEY
```

### Flujo interno

```
X-API-Key  →  SHA-256  →  SELECT ... FROM api_client WHERE token_hash = ?
        │
        ├─ sin header            → 401
        ├─ hash no encontrado    → 401 "API key inválida"
        ├─ activo = false        → 403 "Cliente inactivo"
        ├─ sin el permiso        → 403 "Cliente sin permiso para esta operación"
        └─ > 120 req/min         → 429
```

> La clave **nunca se guarda en texto plano**: en la tabla `api_client` solo
> existe su hash SHA-256 (`token_hash`). Tampoco se registra en logs
> (hay un helper `enmascarar()` que reemplaza cualquier `sk_live_...`).

### Tabla de errores de autenticación

| Código | `error` | Causa | Qué hacer |
|---|---|---|---|
| `401` | `API key requerida en el header X-API-Key` | Falta el header | Agregarlo a la petición |
| `401` | `API key inválida` | La clave no existe o fue rotada | Solicitar la clave vigente |
| `403` | `Cliente inactivo` | Cliente deshabilitado | Pedir reactivación al equipo dueño |
| `403` | `Cliente sin permiso para esta operación` | `puede_insertar` o `puede_consultar` en `false` | Pedir ajuste de permisos |
| `429` | `Demasiadas solicitudes, intente más tarde` | Superó el rate limit | Reintentar con backoff (ver §6) |
| `500` | `Error de autenticación` | Falla interna | Reintentar; si persiste, escalar |

### Permisos por endpoint

| Endpoint | Permiso requerido (`api_client`) |
|---|---|
| `POST /ubicabilidad/personas` | `puede_insertar = true` |
| `POST /ubicabilidad/resultados` | `puede_consultar = true` |
| `GET  /ubicabilidad/personas/:tipo/:documento` | `puede_consultar = true` |

---

## 3. Gestión de credenciales (operadores)

### Dar de alta un cliente nuevo

```bash
node scripts/seedApiClient.js COBRO_COACTIVO "Cobro Coactivo"
```

- El código va en **MAYÚSCULAS**, sin espacios, y debe cumplir
  `^[A-Z][A-Z0-9_]{1,49}$`.
- Si el cliente ya existe, el script **rota el token** (la clave anterior
  deja de funcionar) y lo vuelve a activar.
- La clave se imprime **una sola vez**: guárdela en el gestor de
  contraseñas del equipo. No queda copia recuperable.

```
  Código        : COBRO_COACTIVO
  Nombre        : Cobro Coactivo
  Origen en BD  : API_COBRO_COACTIVO
  X-API-Key     : sk_live_...
```

### Fijar una clave conocida (rotación planificada)

```bash
node scripts/seedApiClient.js VENTANILLA "Ventanilla Virtual" --key=sk_live_valor_fijado
```

### Desactivar un cliente

```sql
UPDATE api_client SET activo = FALSE WHERE codigo = 'VENTANILLA';
```

### Quitar permisos sin desactivar

```sql
UPDATE api_client SET puede_insertar = FALSE WHERE codigo = 'CIVITRANS';
```

### Ver uso reciente

```sql
SELECT codigo, nombre, activo, puede_insertar, puede_consultar, fecha_ultimo_uso
FROM api_client ORDER BY fecha_ultimo_uso DESC NULLS LAST;
```

### Origen que queda en BD

Cada inserción de un cliente `X` escribe `origen_registro = 'API_X'`.
Esto es lo que separa los datos de la API de la carga por Excel/fotodetección
(`CARGADO_POR_EXCEL`, `SCRAPING`) en el panel del funcionario.

---

## 4. Endpoints

### 4.1 Ingesta de personas

```
POST /api/v1/integraciones/ubicabilidad/personas
```
Permiso: `puede_insertar`

#### Request

```jsonc
{
  "anio": 2026,                            // opcional, año por defecto de TODO el lote
  "personas": [
    {
      "tipo_documento": "CC",                 // obligatorio
      "numero_documento": "1032456789",       // obligatorio, máx. 30 chars
      "anio": 2026,                           // opcional, pisa el del lote
      "referencia_externa": "EXP-2026-00123", // opcional, eco en la respuesta
      "metadata": {                           // opcional, objeto JSON
        "radicado": "R-8891",
        "anio_consulta": 2026                 // opcional, otra forma de enviar el año
      }
    }
  ]
}
```

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `personas` | array | ✅ | No vacío, máx. 5000 por petición |
| `anio` (raíz) | number | ❌ | Año por defecto del lote. Entero entre 2000 y el año actual + 1 |
| `tipo_documento` | string | ✅ | Se homologa; ver §5. Máx. 60 chars |
| `numero_documento` | string | ✅ | Máx. 30 chars |
| `anio` (persona) | number | ❌ | Pisa el año del lote para esa persona. Mismo rango |
| `anio_consulta` (persona) | number | ❌ | Alias de `anio`. Misma prioridad y validación |
| `metadata.anio_consulta` | number | ❌ | Otra forma de enviar el año. Se lee si no hay `anio` explícito |
| `referencia_externa` | string | ❌ | **No se persiste**: solo se devuelve como eco |
| `metadata` | object | ❌ | **No se persiste** (excepto `metadata.anio_consulta`, que sí se lee) |

> **Sobre `anio`.** Es el año de los comparendos que motivan la solicitud.
> Se **sí persiste** (columna `anio_consulta`) y sirve para que el operador
> filtre las solicitudes por año en la pantalla de Ubicabilidad Personas.
> **No** modifica el scraping: la consulta de direcciones en RUNT es persona
> por persona y no admite filtro por año.
>
> **Precedencia del año.** De mayor a menor:
> 1. `personas[i].anio`
> 2. `personas[i].anio_consulta`
> 3. `personas[i].metadata.anio_consulta` (o `metadata.anio`)
> 4. `anio` de la raíz
> 5. `anio_consulta` de la raíz
> 6. `metadata.anio_consulta` de la raíz
>
> Se recorren en ese orden y se usa **la primera fuente con un año válido**.
> Si una viene corrupta pero otra trae el año bien, se usa la buena. Solo se
> devuelve `400` (raíz) o `INVALIDO` (persona) cuando **todas** las que
> vinieron son inválidas. Si ninguna viene, la persona queda con año `NULL`
> («Sin año» en pantalla).
>
> CONTRAVENCIONES envía el año en `metadata.anio_consulta`, así que esa forma
> funciona igual que `anio` explícito.
>
> **Re-consultas.** Si la persona ya existía con un año **menor** al que ustedes
> envían, vuelve a la cola (`REACTIVADO`) y se consulta de nuevo. Si el año es
> igual o menor, se responde `YA_EXISTIA` y no se repite la consulta.
>
> `referencia_externa` y `metadata` sirven para que ustedes correlacionen
> la respuesta con su expediente. Si necesitan el dato después, guárdenlo
> de su lado y reenvíenlo en el polling.

#### Respuesta `200`

```jsonc
{
  "ok": true,
  "cliente": "CONTRAVENCIONES",
  "total_recibidos": 4,
  "insertados": 1,
  "reactivados": 1,
  "existentes": 1,
  "invalidos": 1,
  "duplicados": 0,
  "fallidos": 0,
  "personas": [
    {
      "referencia_externa": "EXP-2026-00123",
      "tipo_documento": "CC",                 // eco del valor enviado
      "numero_documento": "1032456789",
      "anio": 2026,
      "metadata": { "radicado": "R-8891" },
      "estado_recepcion": "INSERTADO",
      "estado_consulta": "PENDIENTE",
      "resultado_disponible": false
    },
    {
      "tipo_documento": "CC",
      "numero_documento": "7988887776",
      "anio": 2026,
      "estado_recepcion": "REACTIVADO",
      "estado_consulta": "PENDIENTE",
      "resultado_disponible": false
    },
    {
      "tipo_documento": "CC",
      "numero_documento": "8001112223",
      "anio": 2025,
      "estado_recepcion": "YA_EXISTIA",
      "estado_consulta": "ENCONTRADA",
      "resultado_disponible": true,
      "persona":  { "nombres": "MARIA", "apellidos": "PEREZ", "celular": "3001234567", "correo": null },
      "direccion": { "direccion": "CL 12 34 56", "municipio": "BOGOTA D.C.", "telefono": "3001234567", "tipo_direccion": "RESIDENCIA" },
      "fecha_consulta": "2026-10-16T15:10:12.935Z"
    },
    {
      "tipo_documento": "",
      "numero_documento": "",
      "estado_recepcion": "INVALIDO",
      "estado_consulta": null,
      "resultado_disponible": false,
      "error": "tipo_documento y numero_documento son obligatorios"
    }
  ]
}
```

**Los contadores (`insertados`, `reactivados`, `existentes`, `invalidos`,
`duplicados`, `fallidos`) suman exactamente `total_recibidos`.**

> ⚠️ Si `fallidos > 0`, la API responde **`400` o `500`** con `ok: false`
> (ver más abajo). **Nunca** responde `200` dando por hecho personas que
> no se guardaron.

#### `estado_recepcion`

| Valor | Significado |
|---|---|
| `INSERTADO` | Persona nueva creada con origen `API_<SU_CODIGO>` |
| `REACTIVADO` | Ya existía con un año de consulta menor; volvió a la cola para re-consultarse |
| `YA_EXISTIA` | Ya estaba en la base con el mismo año o sin año (cualquier origen: API, Excel, scraping) |
| `INVALIDO` | Falta un campo obligatorio, supera la longitud máxima o el `anio` no es válido |
| `DUPLICADO` | Aparece dos veces **dentro de la misma petición** |
| `ERROR` | El `INSERT` de esa fila falló y **no** se guardó; el detalle va en `error` |

#### Errores

| Código | `error` | Cuándo |
|---|---|---|
| `400` | `Debe enviar "personas" como arreglo no vacío` | Body mal formado |
| `400` | `anio debe ser un entero entre 2000 y YYYY` | El `anio` de la raíz no es válido |
| `400` | `Uno o más valores exceden el largo permitido por la base de datos` | `fallidos > 0` y todos los fallos son por longitud (`22001`) |
| `413` | `Máximo 5000 personas por solicitud (recibidas: N)` | Se superó el máximo |
| `500` | `No se pudieron insertar todas las personas` | `fallidos > 0` por otra causa |
| `500` | `Error procesando la solicitud` | Falla inesperada del servidor |

> Un `anio` inválido **dentro de una persona** no rechaza el lote: esa fila
> sale como `INVALIDO` con `error: "anio debe ser un entero entre 2000 y YYYY"`
> y el resto se procesa con normalidad.

> Los `400`/`500` de inserción **sí traen el cuerpo completo**
> (`insertados`, `reactivados`, `existentes`, `fallidos` y `personas[]` con el
> detalle por fila), para que puedan reenviar únicamente lo que faltó.
>
> **Nota de robustez:** si un registro del lote no se puede guardar, la API
> reintenta **fila por fila**, de modo que un registro malo no descarta a los
> demás. Solo las filas que siguen fallando aparecen como `ERROR`.

#### Ejemplo `curl`

```bash
curl -X POST "http://84.247.165.214:3000/api/v1/integraciones/ubicabilidad/personas" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sk_live_SU_CLAVE" \
  -d '{
    "anio": 2026,
    "personas": [
      { "tipo_documento": "CC", "numero_documento": "1032456789", "referencia_externa": "EXP-1" }
    ]
  }'
```

---

### 4.2 Consulta de resultados (polling)

```
POST /api/v1/integraciones/ubicabilidad/resultados
```
Permiso: `puede_consultar`

Envíen **el mismo lote** que insertaron. La respuesta refleja el avance
actual de cada persona.

#### Request

```jsonc
{
  "personas": [
    { "tipo_documento": "CC", "numero_documento": "1032456789", "referencia_externa": "EXP-2026-00123" }
  ]
}
```

Mismas reglas que la ingesta: arreglo no vacío, máximo 5000.

#### Respuesta `200`

```jsonc
{
  "ok": true,
  "cliente": "CONTRAVENCIONES",
  "total_solicitados": 2,
  "resumen": {
    "pendientes": 0,
    "encontrados": 1,
    "sin_informacion": 0,
    "errores": 0,
    "no_registradas": 1
  },
  "personas": [
    {
      "referencia_externa": "EXP-2026-00123",
      "tipo_documento": "CC",
      "numero_documento": "1032456789",
      "estado": "ENCONTRADA",
      "resultado_disponible": true,
      "persona":  { "nombres": "MARIA", "apellidos": "PEREZ", "celular": "3001234567", "correo": null },
      "direccion": { "direccion": "CL 12 34 56", "municipio": "BOGOTA D.C.", "telefono": "3001234567", "tipo_direccion": "RESIDENCIA" },
      "fecha_consulta": "2026-10-16T15:10:12.935Z"
    },
    {
      "tipo_documento": "CC",
      "numero_documento": "9999999999",
      "estado": "NO_REGISTRADA",
      "resultado_disponible": false
    }
  ]
}
```

#### Errores

| Código | `error` |
|---|---|
| `400` | `Debe enviar "personas" como arreglo no vacío` |
| `413` | `Máximo 5000 personas por solicitud` |
| `500` | `Error consultando la solicitud` |

#### Ejemplo `curl`

```bash
curl -X POST "http://84.247.165.214:3000/api/v1/integraciones/ubicabilidad/resultados" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: sk_live_SU_CLAVE" \
  -d '{
    "personas": [
      { "tipo_documento": "CC", "numero_documento": "1032456789", "referencia_externa": "EXP-1" }
    ]
  }'
```

---

### 4.3 Consulta individual

```
GET /api/v1/integraciones/ubicabilidad/personas/:tipo/:documento
```
Permiso: `puede_consultar`

Ejemplo: `GET /api/v1/integraciones/ubicabilidad/personas/CC/1032456789`

#### Respuesta `200`

```jsonc
{
  "ok": true,
  "tipo_documento": "Cédula Ciudadanía",   // valor canónico guardado en BD
  "numero_documento": "1032456789",
  "estado": "ENCONTRADA",
  "persona":  { "nombres": "MARIA", "apellidos": "PEREZ", "celular": "3001234567", "correo": null },
  "direccion": { "direccion": "CL 12 34 56", "municipio": "BOGOTA D.C.", "telefono": "3001234567", "tipo_direccion": "RESIDENCIA" },
  "fecha_consulta": "2026-10-16T15:10:12.935Z"
}
```

#### Respuesta `404` — no está registrada

```jsonc
{
  "ok": false,
  "tipo_documento": "CC",
  "numero_documento": "1032456789",
  "estado": "NO_REGISTRADA"
}
```

> ⚠️ **`404` aquí no es un error técnico**: significa que la persona no
> existe en la base. No lo traten como falla del servicio.

#### Otros errores

| Código | `error` |
|---|---|
| `400` | `tipo y documento son obligatorios` |
| `500` | `Error consultando la persona` |

#### Ejemplo `curl`

```bash
curl "http://84.247.165.214:3000/api/v1/integraciones/ubicabilidad/personas/CC/1032456789" \
  -H "X-API-Key: sk_live_SU_CLAVE"
```

---

## 5. Estados y homologación

### 5.1 `estado` (estado de consulta de la persona)

| Valor | Significado en BD | ¿Hay resultado? |
|---|---|---|
| `PENDIENTE` | Insertada, aún no se procesa | No |
| `EN_PROCESO` | Un **worker** la está procesando en este momento | No |
| `ENCONTRADA` | Consulta exitosa con dirección | ✅ **Sí** |
| `SIN_INFORMACION` | Consultada, RUNT/direcciones no reportan datos | No |
| `ERROR` | Consulta falló con error técnico | No (`error` trae el detalle) |
| `NO_REGISTRADA` | No existe en la base | No |

> `SIN_INFORMACION` vs `ERROR`: se distingue por el texto del error.
> Frases como *"no se encontró"*, *"sin información"*, *"no existe"*,
> *"no registra"* se clasifican como `SIN_INFORMACION` (resultado legítimo),
> el resto como `ERROR` (falla técnica).

Cuando `estado = "ENCONTRADA"`, la respuesta incluye:

```jsonc
{
  "persona":  { "nombres": "...", "apellidos": "...", "celular": "...", "correo": "..." },
  "direccion": { "direccion": "...", "municipio": "...", "telefono": "...", "tipo_direccion": "..." },
  "fecha_consulta": "2026-10-16T15:10:12.935Z"
}
```

Todos los campos pueden ser `null`. `municipio` corresponde a
`municio_departamento` en BD (sic — nombre histórico de la columna).

### 5.2 Homologación de `tipo_documento`

Al **insertar** se guarda el valor canónico; al **buscar** se comparan todas
las variantes. Así no se generan duplicados por diferencia de grafía.

| Código | Valor canónico (se guarda en BD) | Alias aceptados |
|---|---|---|
| `CC` | `Cédula Ciudadanía` | `CC`, `C.C`, `C.C.`, `CEDULA`, `CEDULA DE CIUDADANIA`, `CEDULA CIUDADANIA` |
| `CE` | `Cédula de Extranjería` | `CE`, `C.E`, `C.E.`, `CEDULA DE EXTRANJERIA`, `CEDULA EXTRANJERIA` |
| `NIT` | `NIT` | `NIT`, `N.I.T`, `N.I.T.` |
| `PAS` | `Pasaporte` | `PA`, `PAS`, `PASAPORTE` |
| `PPT` | `Permiso por Protección Temporal` | `PPT`, `P.P.T`, `P.P.T.`, `PERMISO POR PROTECCION TEMPORAL` |
| `RC` | `Registro Civil` | `RC`, `REGISTRO CIVIL` |
| `TI` | `Tarjeta de Identidad` | `TI`, `TARJETA DE IDENTIDAD`, `TARJETA IDENTIDAD` |

**Notas:**

- La comparación ignora tildes, puntos, guiones y mayúsculas.
- Si envían un tipo que **no** está en la tabla, **se guarda tal cual**
  (no se rechaza; el dato no se pierde).
- En la respuesta de la ingesta, `tipo_documento` devuelve el valor
  **tal cual lo enviaron** (eco); en el `GET` individual devuelve el valor
  **canónico** guardado.

### 5.3 Llave de identidad

La persona se identifica por **`numero_documento` + tipo homologado**.
El `INSERT ... ON CONFLICT (tipo_documento, numero_documento) DO NOTHING`
garantiza la idempotencia a nivel de base de datos.

---

## 6. Límites y comportamiento

| Límite | Valor | Variable de entorno |
|---|---|---|
| Personas por petición | 5000 | `INTEGRACION_MAX_PERSONAS` |
| Tamaño del body | 5 MB | — (hardcodeado en `server.js` y en el router) |
| Solicitudes por minuto | 120 / min / cliente | `API_RATE_LIMIT` |
| `numero_documento` | ≤ 30 caracteres | — |
| `tipo_documento` | ≤ 60 caracteres | — |
| `anio` | entero entre 2000 y (año actual + 1) | — |
| Ítems por job (interno) | 90 | — (`MAX_ITEMS_POR_JOB`) |

> Los límites de longitud **coinciden con las columnas de la base**
> (`tipo_documento varchar(60)`, `numero_documento varchar(30)`). Si un valor
> los excede, la fila aparece como `INVALIDO` (validación previa) o, en el
> peor caso, como `ERROR` (rechazo de la base, SQLSTATE `22001`).
>
> Migraciones asociadas:
> - `scripts/ampliarTipoDocumento.sql` (`tipo_documento` 30→60,
>   `origen_registro` 50→60). El valor canónico de PPT mide 31 caracteres y
>   con la columna en 30 **revierta el lote completo**.
> - `scripts/addAnioConsulta.sql` (agrega `anio_consulta smallint` y su índice).
>   Sin esta migración, los endpoints de pendientes fallan.
>
> **Si los datos ya existen sin año** (se insertaron antes de la migración) y no
> quieres reenviar el lote desde el servicio externo, puedes asignarlo a mano:
>
> ```bash
> node scripts/setAnioConsulta.js 2025          # solo cuenta (dry run)
> node scripts/setAnioConsulta.js 2025 --aplicar  # escribe
> node scripts/setAnioConsulta.js 2025 --aplicar --reactivar  # además re-encola
> ```
>
> Por defecto solo toca filas con `anio_consulta IS NULL` y **no** altera las
> marcas de consulta, así que las direcciones ya obtenidas se conservan. Con
> `--reactivar` sí se re-encolan para volver a scrapear.

### Rate limit

- Ventana de **60 segundos**, contador por `id_api_client`.
- Es **en memoria**: se reinicia junto con el servidor y no se comparte
  entre múltiples instancias.
- Al superarlo responde `429`. Recomendado: reintentar con backoff
  exponencial (1s, 2s, 4s… máx. 60s) y no más de ~2 peticiones por segundo
  en cargas normales.

### Idempotencia

Reenviar la misma persona **nunca duplica registros**:

- 1.ª vez → `estado_recepcion: "INSERTADO"`
- 2.ª vez (mismo año o sin año) → `estado_recepcion: "YA_EXISTIA"`, `insertados: 0`
- 2.ª vez con un año **mayor** → `estado_recepcion: "REACTIVADO"`, `reactivados: 1`
  (vuelve a la cola de pendientes y se vuelve a consultar)

Esto también aplica si la persona ya fue cargada por Excel o por
fotodetección: se reporta `YA_EXISTIA` y se conserva su estado actual.

### Filtrado por año en la pantalla del operador

El operador carga las solicitudes API y elige, en este orden:

1. **Año de los comparendos** (chips con el conteo de pendientes por año)
2. **Servicio que envió la solicitud** (`origen_registro`)
3. **Tipo de documento**

Cada grupo muestra `por procesar` y `en cola`. Lo que ya está en un job
**no se vuelve a cargar**: los contadores bajan solos cuando el trabajo
termina. El lote que se envía al worker es siempre de **90**.

### Concurrencia

Varias peticiones simultáneas del mismo cliente son seguras: el
`ON CONFLICT` resuelve las carreras y, en ese caso, la respuesta se marca
`YA_EXISTIA` con `estado_consulta` en `PENDIENTE` o `EN_PROCESO`.

---

## 7. Flujo de integración recomendado

```
┌────────────────────┐   POST /personas     ┌──────────────────────────┐
│  Sistema externo   │ ───────────────────► │  API de integración      │
│  (su aplicación)   │                      │  inserta con origen API_ │
└─────────┬──────────┘                      └────────────┬─────────────┘
          │                                              │
          │  (espera)                                    ▼
          │                              ┌──────────────────────────────┐
          │                              │  Panel del funcionario       │
          │                              │  "Cargar solicitudes API"    │
          │                              │  → crea job (90 por job)     │
          │                              └────────────┬─────────────────┘
          │                                           ▼
          │                              ┌──────────────────────────────┐
          │                              │  Worker interno              │
          │                              │  consulta RUNT / direcciones │
          │                              └────────────┬─────────────────┘
          │                                           │
          │   POST /resultados (polling)              ▼
          └─────────────────────────────  ◄──  estado: ENCONTRADA
```

**Pasos:**

1. Su sistema envía el lote a `POST /ubicabilidad/personas`.
2. Un funcionario abre el panel → **Cargar solicitudes API** → ve los
   pendientes de su origen → **Crear Job**.
3. El worker procesa los lotes (90 personas por job) y va consultando
   direcciones.
4. Su sistema hace **polling** contra `POST /ubicabilidad/resultados`
   (sugerido: cada 30–60 s) hasta que todas estén `ENCONTRADA`,
   `SIN_INFORMACION` o `ERROR`.
5. Al recibir `ENCONTRADA`, recuperan `persona` y `direccion`.

**Recomendación de polling:** no consulten por persona individual cuando
tengan muchos registros; usen `POST /resultados` con el lote completo y
aprovechen el bloque `resumen`.

---

## 8. Checklist de onboarding para una API nueva

Antes de conectar cada sistema (COBRO_COACTIVO, VENTANILLA, CIVITRANS…):

- [ ] **1. Definir el código** — mayúsculas, sin espacios, `^[A-Z][A-Z0-9_]{1,49}$`.
- [ ] **2. Alta del cliente**
      `node scripts/seedApiClient.js <CODIGO> "<Nombre legible>"`
- [ ] **3. Entregar la clave** por un canal seguro (gestor de contraseñas,
      nunca correo ni chat de texto). **Se imprime una sola vez.**
- [ ] **4. Definir permisos** — ¿necesita insertar, consultar, o ambas?
- [ ] **5. Prueba de autenticación**
      ```bash
      # debe responder 400 (falta el body), lo que confirma que la key es válida
      curl -X POST -H "X-API-Key: sk_live_SU_CLAVE" \
        http://84.247.165.214:3000/api/v1/integraciones/ubicabilidad/personas
      # {"ok":false,"error":"Debe enviar \"personas\" como arreglo no vacío"}
      ```
- [ ] **6. Prueba de inserción** con 1–3 personas de prueba.
- [ ] **7. Verificar en BD** que aparece el origen:
      ```sql
      SELECT origen_registro, COUNT(*)
      FROM persona_natural_propietario
      WHERE origen_registro = 'API_<CODIGO>'
      GROUP BY 1;
      ```
- [ ] **8. Prueba de idempotencia** — reenviar el mismo lote y confirmar
      `insertados: 0` / `existentes: N`.
- [ ] **9. Acordar el flujo de polling** y el responsable operativo.
- [ ] **10. Registrar la fecha de alta** y el canal de escalamiento.

---

## 9. Notas de seguridad

### Obligatorio

1. **Nunca** incluir la API key en la URL, en query strings ni en el cuerpo
   de la petición. Solo en el header `X-API-Key`.
2. **Nunca** commitear claves en repositorios ni compartirlas por correo/chat.
   Usar el gestor de contraseñas del equipo.
3. Transmitir todo por **HTTPS** detrás del proxy reverso (el servicio Node
   escucha HTTP en el puerto 3000).
4. La clave vive solo en el cliente: en la base está hasheada con SHA-256.
   Si la clave se filtra → **rotarla** con `seedApiClient.js --key=...`
   (la anterior deja de funcionar de inmediato).
5. Cada sistema debe tener **su propio cliente**; no compartir una misma key
   entre equipos. Así el rate limit, los permisos y el `origen_registro`
   quedan aislados.

### Riesgo conocido y bajo revisión

> Los endpoints internos del módulo
> (`/api/ubicabilidad-personas/*`, `/api/worker-jobs/*`, `/api/runt/*`)
> **no llevan `X-API-Key`** y algunos usan JWT de usuario; no forman parte
> de esta API. **No exponerlos** fuera de la red interna ni a los sistemas
> externos. Solo la ruta `/api/v1/integraciones/**` está pensada para
> consumo externo.

### Logs del servidor

Cada llamada deja una línea estructurada que **no** contiene la clave:

```
[integracion] cliente=CONTRAVENCIONES endpoint=/ubicabilidad/personas
recibidos=150 insertados=142 existentes=5 invalidos=2 duplicados=1 fallidos=0 tiempo=312ms
```

> Si un registro no se pudo guardar, el log trae `fallidos=N` y, al lado,
> una línea por fila rechazada. En ese caso la respuesta es `400`/`500`,
> nunca `200`.

Útil para diagnosticar. En `api_client.fecha_ultimo_uso` queda la marca de
la última autenticación exitosa.

---

## 10. Referencia rápida

| Método | Ruta | Permiso | Propósito |
|---|---|---|---|
| `POST` | `/api/v1/integraciones/ubicabilidad/personas` | `puede_insertar` | Insertar personas |
| `POST` | `/api/v1/integraciones/ubicabilidad/resultados` | `puede_consultar` | Consultar avance (polling) |
| `GET` | `/api/v1/integraciones/ubicabilidad/personas/:tipo/:documento` | `puede_consultar` | Consultar una persona |

```http
X-API-Key: sk_live_...
Content-Type: application/json
```

| Código HTTP | Significado |
|---|---|
| `200` | OK |
| `400` | Body inválido, parámetros faltantes o valores demasiado largos |
| `401` | Sin API key o clave inválida |
| `403` | Cliente inactivo o sin permiso |
| `404` | Persona no registrada (solo en el endpoint individual) |
| `413` | Body demasiado grande / más de 5000 personas |
| `429` | Rate limit superado |
| `500` | Error interno o inserción parcialmente fallida (`fallidos > 0`) |
