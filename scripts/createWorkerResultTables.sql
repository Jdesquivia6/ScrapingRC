-- Tablas para guardar resultados de scraping desde workers locales

-- Agregar columna fk_usuario a consultas_placas si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'consultas_placas' AND column_name = 'fk_usuario'
    ) THEN
        ALTER TABLE consultas_placas ADD COLUMN fk_usuario UUID;
    END IF;
END $$;

-- Tabla de datos de vehículo
CREATE TABLE IF NOT EXISTS runt_datos_vehiculo (
    id SERIAL PRIMARY KEY,
    placa VARCHAR(20) UNIQUE NOT NULL,
    clase VARCHAR(100),
    marca VARCHAR(100),
    linea VARCHAR(100),
    servicio VARCHAR(100),
    color VARCHAR(50),
    modelo VARCHAR(10),
    estado_consulta BOOLEAN DEFAULT false,
    error_consulta TEXT,
    fecha_consulta TIMESTAMP,
    fk_usuario UUID,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Tabla de direcciones de personas
CREATE TABLE IF NOT EXISTS runt_direcciones (
    id SERIAL PRIMARY KEY,
    tipo_identificacion VARCHAR(20) NOT NULL,
    numero_identificacion VARCHAR(50) NOT NULL,
    direcciones JSONB,
    fk_usuario UUID,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT unique_persona_direccion UNIQUE (tipo_identificacion, numero_identificacion)
);

-- Tabla de liquidaciones
CREATE TABLE IF NOT EXISTS runt_liquidaciones (
    id SERIAL PRIMARY KEY,
    placa VARCHAR(20) NOT NULL,
    tipo_servicio VARCHAR(100),
    total DECIMAL(10,2),
    detalles JSONB,
    fk_usuario UUID,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT unique_placa_liquidacion UNIQUE (placa)
);

-- Verificar tablas creadas
SELECT 
    'consultas_placas' as table_name, count(*) as exists 
FROM information_schema.tables 
WHERE table_name = 'consultas_placas'
UNION ALL
SELECT 
    'runt_datos_vehiculo', count(*) 
FROM information_schema.tables 
WHERE table_name = 'runt_datos_vehiculo'
UNION ALL
SELECT 
    'runt_direcciones', count(*) 
FROM information_schema.tables 
WHERE table_name = 'runt_direcciones'
UNION ALL
SELECT 
    'runt_liquidaciones', count(*) 
FROM information_schema.tables 
WHERE table_name = 'runt_liquidaciones';