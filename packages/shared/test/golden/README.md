# Suite dorada

Cada archivo de `cases/` pasa por el lector y las reglas con un contexto fijo (SEA, 80 %, 15 días, "hoy" = 2026-09-23) y su resultado se compara con el snapshot de `expected/`. Los casos `seed-*.xml` los genera la fábrica de XML de prueba; los demás son XML reales de proveedores.

## Agregar un XML real

1. Guardar el original en `private/` (ignorado por git; nunca se commitea).
2. Copiarlo a `cases/` con un nombre descriptivo: `<pagador>-<caso>.xml`, por ejemplo `sea-credito-detraccion-2cuotas.xml`.
3. Anonimizar la copia: reemplazar las razones sociales por `EMISOR ANONIMO N`, y los correos y direcciones si aparecen. El RUC es público y se conserva; los montos pueden conservarse o escalarse, pero todos por el mismo factor.
4. Correr `pnpm --filter @anticipate/shared exec vitest run test/golden -u` para crear el snapshot, y revisar `expected/<caso>.json` a mano: es la afirmación de cómo debe comportarse el sistema con ese XML.
5. Commitear caso y snapshot juntos. El revisor del PR lee el JSON, no el XML.

Si un snapshot cambia sin que cambie el caso, cambió una regla: el PR tiene que explicar por qué.
