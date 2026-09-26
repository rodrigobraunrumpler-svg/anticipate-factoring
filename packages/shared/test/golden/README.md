# Suite dorada

Cada archivo de `cases/` se lee como bytes con `decodeXml` (igual que la API), pasa por el lector y las reglas con un contexto fijo (SEA, 80 %, 15 días, "hoy" = 2026-09-23) y su resultado se compara con el snapshot de `expected/`.

Hoy la suite solo tiene casos semilla (`seed-*.xml`), generados con la fábrica de XML de prueba (`@anticipate/shared/testing`) por `pnpm --filter @anticipate/shared exec tsx test/golden/generate-seed-cases.ts`. El más cercano a un XML real es `seed-sunat-realistic.xml`: dos `UBLExtension` con la firma en la segunda, `cac:Signature` de primer nivel, razón social en CDATA, finales CRLF, bytes ISO-8859-1 y detracción al 12 %. Los XML reales de proveedores se agregan con el procedimiento de abajo; todo caso que no empieza con `seed-` se trata como real.

Cuatro semillas fijan las reglas de fecha y las gemelas de las restricciones CHECK de la base (D49): `seed-issue-date-in-future.xml` (emisión posterior a "hoy"), `seed-due-before-issue.xml` (una cuota vence antes de la emisión), `seed-installment-zero.xml` (una cuota con monto cero) y `seed-net-exceeds-total.xml` (neto pendiente mayor que el total). El XML de cada una se lee bien y termina en su problema; `golden.test.ts` lo comprueba además del snapshot. Ninguna semilla anterior cambió de resultado con esas reglas.

`seed-nul-in-name.xml` es la gemela del tipo de las columnas de texto: trae un byte `0x00` en la razón social, que XML 1.0 no admite y PostgreSQL no guarda. Termina en `UNREADABLE_XML`, nunca en un INSERT que la base rechaza; `golden.test.ts` lo comprueba además del snapshot. Git lo trata como binario por ese byte.

## Agregar un XML real

1. Guardar el original en `private/` (ignorado por git; nunca se commitea).
2. Copiarlo a `cases/` con un nombre descriptivo: `<pagador>-<caso>.xml`, por ejemplo `sea-credito-detraccion-2cuotas.xml`.
3. Anonimizar la copia:
   - Las razones sociales, por `EMISOR ANONIMO N`.
   - Los teléfonos, correos, direcciones y números de cuenta bancaria / CCI, donde aparezcan.
   - El texto de cada `ds:SignatureValue`, `ds:DigestValue` y `ds:X509Certificate` (cualquier prefijo de espacio de nombres), por `ANONIMIZADO`. Se conservan los elementos —la factura debe seguir leyéndose como firmada—, solo se vacía su contenido: el certificado X.509 real puede llevar el nombre y el DNI de la persona natural que firmó, y el historial de git es permanente (Ley 29733). `golden.test.ts` exige esto para todo caso cuyo nombre no empiece con `seed-` y falla nombrando el archivo y el elemento si falta.
   - El RUC es público y se conserva; los montos pueden conservarse o escalarse, pero todos por el mismo factor.
4. Correr `pnpm --filter @anticipate/shared exec vitest run test/golden -u` para crear el snapshot, y revisar `expected/<caso>.json` a mano: es la afirmación de cómo debe comportarse el sistema con ese XML.
5. Commitear caso y snapshot juntos. El revisor del PR lee el JSON, no el XML.

Si un snapshot cambia sin que cambie el caso, cambió una regla: el PR tiene que explicar por qué.
