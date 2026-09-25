import { v7 } from 'uuid'

/**
 * Id de una fila que inserta la API: UUIDv7 (RFC 9562), el mismo tipo que genera la base con
 * `uuidv7()`. Los primeros 48 bits son el milisegundo de creación y `uuid` agrega un contador
 * monótono dentro del proceso, así que ordenar por `id` es ordenar por creación: las listas del admin
 * paginan por `id DESC` y la purga del outbox corta por rango de id (`uuidv7_floor`).
 *
 * Se usa cuando la API necesita el id antes de insertar (la solicitud, cuyo id va en las claves del
 * almacenamiento, y los archivos que reserva antes de subirlos). En el resto, lo asigna la base.
 * Es el único lugar que importa `uuid` (`architecture.test.ts`).
 */
export function newId(): string {
  return v7()
}
