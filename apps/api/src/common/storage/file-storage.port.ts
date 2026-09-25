/**
 * Un archivo por subir. La clave la arma quien llama: siempre ids, nunca nombres del usuario, y
 * nueva: si la subida falla, `putAll` borra cada clave que intentó subir.
 */
export type PutFileInput = { key: string; body: Buffer; contentType: string }

/** Lo que quedó guardado: bucket, clave, tamaño en bytes y SHA-256 del contenido en hexadecimal. */
export type StoredObject = { bucket: string; key: string; sizeBytes: number; sha256: string }

/** Vigencia de los enlaces de descarga firmados (STACK §10). */
export const DOWNLOAD_URL_TTL_SECONDS = 300

/**
 * Único acceso de la aplicación al almacenamiento de archivos. La implementación vive en
 * `infrastructure/storage`; los casos de uso solo conocen este puerto y su token. Ninguna operación
 * queda colgada: todas terminan, bien o con error, en un plazo acotado aunque el proveedor no
 * responda, deje una respuesta a medias o pida esperar antes de reintentar.
 *
 * Claves de objeto. Una clave válida:
 * - no está vacía y ocupa como mucho 1024 bytes en UTF-8 (el límite de S3 y R2);
 * - no empieza con `/` ni tiene segmentos vacíos (`//`, `/` al final) ni segmentos `.` o `..`;
 * - no tiene caracteres de control (C0, DEL, C1) ni surrogates UTF-16 sueltos.
 * Una clave inválida nunca llega al proveedor, donde podría volverse una operación sobre el bucket
 * entero (con una clave vacía, borrarlo o listar todas sus claves): `putAll`, `exists` y
 * `downloadUrl` rechazan (como promesa rechazada, nunca de forma síncrona) y `deleteQuietly` la
 * devuelve entre las no borradas.
 */
export interface FileStoragePort {
  /** Bucket donde quedan los objetos; se guarda en `stored_files.storage_bucket`. */
  readonly bucket: string
  /**
   * Sube todo o nada, en paralelo con un tope. Resuelve con un resultado por entrada y en el mismo
   * orden. Antes de subir nada rechaza si una clave es inválida o se repite. Si una subida falla, no
   * empieza ninguna más, espera a que terminen o venzan las que estaban en curso, borra todas las que
   * intentó subir (también las que fallaron o vencieron: el proveedor pudo guardarlas igual) y rechaza
   * con el error de la primera que falló: al rechazar no queda ninguna subida en curso.
   */
  putAll(inputs: readonly PutFileInput[]): Promise<StoredObject[]>
  /**
   * Borra sin lanzar nunca. Devuelve las claves que NO se pudieron borrar, sin repetir, para que
   * quien llama las deje pendientes. Una clave que no existe cuenta como borrada. Si el proveedor
   * deja de responder, no intenta las que faltan y también las devuelve. Una clave inválida nunca se
   * manda y también se devuelve.
   */
  deleteQuietly(keys: readonly string[]): Promise<string[]>
  /**
   * `true` si el objeto existe y `false` si no; ante una clave inválida o cualquier otro error del
   * proveedor, rechaza.
   */
  exists(key: string): Promise<boolean>
  /**
   * Enlace de descarga firmado por `DOWNLOAD_URL_TTL_SECONDS`. Firmar no contacta al proveedor, así
   * que no comprueba que el objeto exista; sí rechaza una clave inválida. `downloadName` es el nombre
   * con el que el navegador guarda el archivo: la clave interna nunca llega a la persona. Acepta
   * cualquier texto (lo sanea y nunca falla por él) y nunca lanza de forma síncrona: toda falla llega
   * como promesa rechazada.
   */
  downloadUrl(key: string, downloadName: string): Promise<string>
}

export const FILE_STORAGE = Symbol('FILE_STORAGE')
