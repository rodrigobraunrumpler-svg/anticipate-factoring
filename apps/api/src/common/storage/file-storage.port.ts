/** Un archivo por subir. La clave la arma quien llama: siempre ids, nunca nombres del usuario. */
export type PutFileInput = { key: string; body: Buffer; contentType: string }

/** Lo que quedó guardado: bucket, clave, tamaño en bytes y SHA-256 del contenido en hexadecimal. */
export type StoredObject = { bucket: string; key: string; sizeBytes: number; sha256: string }

/** Vigencia de los enlaces de descarga firmados (STACK §10). */
export const DOWNLOAD_URL_TTL_SECONDS = 300

/**
 * Único acceso de la aplicación al almacenamiento de archivos. La implementación vive en
 * `infrastructure/storage`; los casos de uso solo conocen este puerto y su token. Ninguna operación
 * queda colgada: todas terminan, bien o con error, en un plazo acotado aunque el proveedor no
 * responda o deje una respuesta a medias.
 */
export interface FileStoragePort {
  /** Bucket donde quedan los objetos; se guarda en `stored_files.storage_bucket`. */
  readonly bucket: string
  /**
   * Sube todo o nada, en paralelo con un tope. Resuelve con un resultado por entrada y en el mismo
   * orden. Si una subida falla, no empieza ninguna más, espera a que terminen las que estaban en
   * curso, borra las que sí llegaron y rechaza con el error de la primera que falló: al rechazar no
   * queda ninguna subida en curso.
   */
  putAll(inputs: readonly PutFileInput[]): Promise<StoredObject[]>
  /**
   * Borra sin lanzar nunca. Devuelve las claves que NO se pudieron borrar, sin repetir, para que
   * quien llama las deje pendientes. Una clave que no existe cuenta como borrada. Si el proveedor
   * deja de responder, no intenta las que faltan y también las devuelve.
   */
  deleteQuietly(keys: readonly string[]): Promise<string[]>
  /** `true` si el objeto existe y `false` si no; ante cualquier otro error del proveedor, lanza. */
  exists(key: string): Promise<boolean>
  /**
   * Enlace de descarga firmado por `DOWNLOAD_URL_TTL_SECONDS`. Firmar no contacta al proveedor, así
   * que no comprueba que el objeto exista. `downloadName` es el nombre con el que el navegador
   * guarda el archivo: la clave interna nunca llega a la persona.
   */
  downloadUrl(key: string, downloadName: string): Promise<string>
}

export const FILE_STORAGE = Symbol('FILE_STORAGE')
