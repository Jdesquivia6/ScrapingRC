# Envío de resultados a CONTRAVENCIONES (API de enriquecimiento de personas)

Flujo **saliente**: devuelve a Contravenciones la dirección que obtuvimos al consultar
RUNT, para que ahí actualicen o creen la persona.

No confundir con el enriquecer de **fotomultas** (`API_HIKVISION:5051`), que es otro
servicio y otro cliente. Este vive en su propio host y usa `X-API-Key`.

## Configuración

Variables en `.env` (no se versionan):

```
CONTRAVENCIONES_ENRIQUECER_URL=http://contravenciones.civitrans.com.co:4200/v1/rest/api/personas/enriquecer
CONTRAVENCIONES_ENRIQUECER_API_KEY=<la key de contravenciones>
```

Si no se define la clave propia, cae a `API_KEY`.

Cliente único: `utils/contravencionesClient.js`. Envía `X-API-Key`, trocea en lotes de
**1000** (máximo absoluto que ellos aceptan es 5000) y espera 120 s por lote.

## Qué se envía

Se seleccionan personas con `origen_registro LIKE 'API_%'`, es decir solo las que
Contravenciones nos pidió:

```sql
direccion_consultada = TRUE
AND direccion_encontrada = TRUE
AND COALESCE(anio_consulta, 0) = <anio>
```

El año es el que llegó en el primer payload y quedó guardado en `anio_consulta`.
**No se filtra por `enviado_externo`**: se reenvían también las ya enviadas, por si
cambió la dirección.

Payload por persona:

```json
{
  "tipoDocumento": "CC",
  "numeroDocumento": "1032456789",
  "nombres": "JUAN",
  "apellidos": "PEREZ",
  "direccion": "Calle 1 # 2-3",
  "municipioDepartamento": "BOGOTA - CUNDINAMARCA",
  "telefono": "573001234567",
  "correo": "a@b.com"
}
```

Se envía en `POST <URL>/batch` con el array dentro de la propiedad `personas`:

```json
{ "personas": [ { "tipoDocumento": "CC", "...": "..." } ] }
```

Existe también `.../batch-array` (array directo `[...]`), pero en el entorno actual no está
publicado: devuelve `401` con cuerpo vacío sin llegar a la aplicación. Se usa `/batch`.

## Homologación de tipos de documento

| Nosotros | Ellos | Acción |
|---|---|---|
| CC, CE, NIT, RC, TI | igual | se envía igual |
| `PAS` (Pasaporte) | `PA` | se traduce |
| `SC` / Salvoconducto | `SC` | se envía igual |
| **`PPT`** (Permiso por Protección Temporal) | **no soportado** | **no se envía** |

`PPT` queda fuera del lote y se reporta en `noSoportadas` / `porTipoNoSoportado`,
pidiendo a Contravenciones que lo agreguen a su lista.

El teléfono se reduce a solo dígitos.

## Endpoints

### `POST /api/ubicabilidad-personas/enviar-externo`

Body: `{ anio, origen?, limite? }`

| Campo | Descripción |
|---|---|
| `anio` | año de consulta (4 dígitos) o `0` para «sin año» |
| `origen` | opcional, restringe a un `API_*` concreto |
| `limite` | opcional, máximo 20000 (por defecto 5000) |

Respuesta `200`:

```json
{
  "ok": true,
  "anio": 2023,
  "seleccionadas": 90,
  "enviadas": 88,
  "exitosas": 40,
  "fallidas": 0,
  "yaExistian": 48,
  "noSoportadas": 2,
  "porTipoNoSoportado": { "PPT": 2 },
  "errores": []
}
```

Si Contravenciones no responde o rechaza el lote: `502` con el mensaje.

### Contadores por año

`GET /api/ubicabilidad-personas/pendientes-api` devuelve en `anios[]`:

| Campo | Significado |
|---|---|
| `total` | pendientes de consultar (sin dirección aún) |
| `conDireccion` | ya consultadas que tienen dirección encontrada |
| `enviadas` | de esas, cuántas ya se enviaron |

Con esos datos la pantalla pinta el botón **«Enviar a contravenciones»** bajo cada
tarjeta de año y el badge `enviadas/conDireccion`.

## Qué se marca en la BD

Por cada persona procesada, en `persona_natural_propietario`:

| Columna | Valor |
|---|---|
| `enviado_externo` | `TRUE` si CONTRAVENCIONES la procesó o ya existía; `FALSE` si falló |
| `fecha_envio_externo` | `NOW()` en ambos casos |
| `intentos_envio_externo` | incrementa |
| `error_envio_externo` | `NULL` si salió bien, mensaje si falló |
| `externo_persona_id` | `personaId` que devuelve CONTRAVENCIONES (trazabilidad) |

Migración: `scripts/addPersonaEnriquecimientoColumns.sql`. Las primeras cuatro columnas
ya existen; **`externo_persona_id` es nueva** y hay que aplicarla. Mientras no exista el
código sigue funcionando y solo se omite el id.

## Flujo completo

1. Contravenciones inserta personas con `anio` → quedan en `API_CONTRAVENCIONES`, pendientes.
2. El operador arma el job por lote de 90 y el worker consulta RUNT.
3. El worker guarda dirección, municipio, teléfono y correo.
4. El operador pulsa **«Enviar a contravenciones»** en la tarjeta del año.
5. Se envía el lote por año y queda marcado `enviado_externo`.
