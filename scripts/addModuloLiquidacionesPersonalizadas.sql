-- Agregar el módulo liquidaciones_personalizadas a la tabla modulos
INSERT INTO modulos (codigo, nombre)
SELECT 'liquidaciones_personalizadas', 'Liquidaciones Personalizadas'
WHERE NOT EXISTS (
  SELECT 1 FROM modulos WHERE codigo = 'liquidaciones_personalizadas'
);
