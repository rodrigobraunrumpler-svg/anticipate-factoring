import { createHash } from 'node:crypto'
import type { AdvanceRequestForm } from '@anticipate/shared/advance-request'

/** Lo que identifica a un archivo en la huella: su campo, su nombre y su contenido. */
export type FingerprintFile = { field: 'xml' | 'pdf'; originalname: string; sha256: string }

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * Versión del formato de la huella. Cambiarla (o cambiar `canonicalJson`) cambia la huella de un
 * envío idéntico: un reintento que cruce el despliegue recibiría 422 `IDEMPOTENCY_KEY_REUSED`.
 */
const FINGERPRINT_FORMAT_VERSION = 1

/** sha256 en hexadecimal minúsculo. Un texto se codifica en UTF-8. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * JSON con las claves de cada objeto ordenadas y sin espacios: el mismo valor produce siempre el
 * mismo texto, sin importar el orden en que se armó. Las propiedades `undefined` se omiten (igual que
 * `JSON.stringify`), así que un opcional ausente y uno `undefined` dan lo mismo. Solo acepta datos
 * JSON: cualquier otra cosa es un error de programación y lanza `TypeError`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('JSON canónico: número no finito')
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
      }
      const prototype: unknown = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('JSON canónico: solo admite objetos planos')
      }
      const record = value as Record<string, unknown>
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      return `{${members.join(',')}}`
    }
    default:
      throw new TypeError(`JSON canónico: tipo no admitido (${typeof value})`)
  }
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Huella de un envío: sha256 del JSON canónico del formulario ya normalizado por
 * `advanceRequestFormSchema` más los archivos `{ field, originalname, sha256 }` ordenados. Dos envíos
 * con los mismos datos y los mismos archivos, en cualquier orden, tienen la misma huella; cambiar
 * un dato, un nombre o un byte la cambia.
 */
export function computeRequestFingerprint(
  form: AdvanceRequestForm,
  files: readonly FingerprintFile[],
): string {
  const entries = files.map(({ field, originalname, sha256 }) => {
    if (!SHA256_HEX.test(sha256)) throw new TypeError(`sha256 inválido en un archivo ${field}`)
    return { field, originalname, sha256 }
  })
  entries.sort(
    (a, b) =>
      compareText(a.field, b.field) ||
      compareText(a.originalname, b.originalname) ||
      compareText(a.sha256, b.sha256),
  )
  return sha256Hex(canonicalJson({ version: FINGERPRINT_FORMAT_VERSION, form, files: entries }))
}
