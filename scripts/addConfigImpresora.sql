-- Tabla para configuración de impresora
CREATE TABLE IF NOT EXISTS config_impresora (
  id SERIAL PRIMARY KEY,
  printer_name VARCHAR(255) DEFAULT '',
  auto_print BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Insertar registro inicial si no existe
INSERT INTO config_impresora (id, printer_name, auto_print)
VALUES (1, '', FALSE)
ON CONFLICT (id) DO NOTHING;
