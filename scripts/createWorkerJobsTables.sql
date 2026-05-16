CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE worker_jobs (
    id_job UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    modulo VARCHAR(100) NOT NULL,
    estado VARCHAR(50) NOT NULL DEFAULT 'pendiente',
    fk_usuario UUID,
    worker_name VARCHAR(150),
    total INT NOT NULL DEFAULT 0,
    procesadas INT NOT NULL DEFAULT 0,
    exitosas INT NOT NULL DEFAULT 0,
    fallidas INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP,
    finished_at TIMESTAMP,
    error TEXT,

    CONSTRAINT chk_worker_jobs_estado CHECK (
      estado IN (
        'pendiente',
        'procesando',
        'pausado',
        'finalizado',
        'fallido',
        'cancelado',
        'sesion_vencida'
      )
    )
);

CREATE TABLE worker_job_items (
    id_item UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    fk_job UUID NOT NULL REFERENCES worker_jobs(id_job)
      ON DELETE CASCADE,

    payload JSONB NOT NULL,

    placa VARCHAR(10),

    documento VARCHAR(50),

    estado VARCHAR(50) NOT NULL DEFAULT 'pendiente',

    resultado JSONB,

    error TEXT,

    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_worker_job_items_estado CHECK (
      estado IN (
        'pendiente',
        'procesando',
        'exitoso',
        'fallido',
        'sin_informacion',
        'timeout',
        'sesion_vencida'
      )
    )
);

CREATE INDEX idx_worker_jobs_estado_modulo_created
ON worker_jobs (
  estado,
  modulo,
  created_at
);

CREATE INDEX idx_worker_jobs_usuario
ON worker_jobs (
  fk_usuario,
  created_at DESC
);

CREATE INDEX idx_worker_job_items_fk_job_estado
ON worker_job_items (
  fk_job,
  estado,
  created_at
);