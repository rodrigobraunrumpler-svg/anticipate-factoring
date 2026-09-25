BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Reemplaza el gate de invoice_installments_same_transaction que comparaba xmin: xmin es quien
-- escribió la última versión de la fila, no quien la creó (un UPDATE sin cambios, que
-- invoices_guard deja pasar, ya bastaba para "tocar" la factura y reabrir la ventana), y dentro de
-- un SAVEPOINT (los `$transaction` anidados de Prisma, o un bloque EXCEPTION de PL/pgSQL) xmin es
-- el xid de la subtransacción mientras pg_current_xact_id() sigue siendo el de la transacción de
-- nivel superior: comparar uno contra el otro rechazaba altas legítimas. La columna de abajo se
-- congela al crear la factura y de ahí en más solo se compara consigo misma.

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "creating_xact_id" xid8 NOT NULL DEFAULT pg_current_xact_id();

COMMIT;
