-- Tabla de clientes API para integraciones de Ubicabilidad Personas.
-- Los sistemas externos (Contravenciones, Cobro Coactivo, Ventanilla, Civitrans)
-- se autentican con header X-API-Key. Nunca se almacena la API key en texto
-- plano: solo su hash SHA-256.

CREATE TABLE IF NOT EXISTS api_client (
    id_api_client      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    codigo             VARCHAR(50)  NOT NULL UNIQUE,
    nombre             VARCHAR(150) NOT NULL,
    token_hash         VARCHAR(255) NOT NULL UNIQUE,
    activo             BOOLEAN      NOT NULL DEFAULT TRUE,
    puede_insertar     BOOLEAN      NOT NULL DEFAULT TRUE,
    puede_consultar    BOOLEAN      NOT NULL DEFAULT TRUE,
    fecha_creacion     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_ultimo_uso   TIMESTAMP,
    creado_por         UUID
);

CREATE INDEX IF NOT EXISTS idx_api_client_token_hash ON api_client (token_hash);
CREATE INDEX IF NOT EXISTS idx_api_client_codigo      ON api_client (codigo);
