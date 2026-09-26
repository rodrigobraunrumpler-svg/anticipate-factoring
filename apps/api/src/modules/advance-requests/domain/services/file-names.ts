import { createProblem, type Problem } from '@anticipate/shared/errors'
import { isFileName, MAX_FILE_NAME_LENGTH } from '@anticipate/shared/text'
import type { UploadedFile } from '../types/invoice-intake.types.js'

/** Puntos de código que se muestran de un nombre que no se puede usar; si hay más, se corta con «…». */
const SHOWN_CODE_POINTS = 64
/** Lo que no se muestra tal cual: controles (Cc), sustitutos sueltos (Cs), U+FFFE y U+FFFF. */
const NOT_SHOWN = /[\p{Cc}\p{Cs}\uFFFE\uFFFF]/u

/**
 * Forma corta de un nombre que no se puede usar, para el mensaje de `INVALID_FILE_NAME`: sus primeros
 * 64 puntos de código, con cada carácter que no se muestra cambiado por U+FFFD, y «…» si había más.
 * Recorre solo lo que muestra, así que un nombre enorme no cuesta más que uno corto. Lo que devuelve
 * siempre cumple `isFileName`, salvo el de un nombre vacío, que queda vacío.
 */
export function displayFileName(name: string): string {
  let shown = ''
  let count = 0
  for (const char of name) {
    if (count === SHOWN_CODE_POINTS) return `${shown}…`
    shown += NOT_SHOWN.test(char) ? '\uFFFD' : char
    count++
  }
  return shown
}

export type FileNameScreening<T extends UploadedFile> = {
  /** Los archivos con un nombre de archivo (`isFileName`), en el orden recibido y por identidad. */
  accepted: T[]
  problems: Problem[]
}

/**
 * Separa los archivos cuyo nombre se puede usar de los demás. La API repite el nombre de un archivo
 * en `file` de cada problema suyo (de una factura con cien cuotas salen unos doscientos), y multer
 * acepta nombres de hasta unos 16 KiB, con controles que JSON escribe con 6 bytes cada uno. Por eso un
 * nombre que no cumple `isFileName` de shared (de 1 a 255 unidades UTF-16, sin controles) se rechaza
 * aquí, una sola vez: es `INVALID_FILE_NAME`, con el nombre acortado (`displayFileName`) en el mensaje
 * y en `params`, y sin `file`, que siempre es un nombre tal como llegó. Ese archivo no se lee ni se
 * empareja: no sale ningún otro problema con su nombre.
 */
export function screenFileNames<T extends UploadedFile>(files: readonly T[]): FileNameScreening<T> {
  const accepted: T[] = []
  const problems: Problem[] = []
  for (const file of files) {
    if (isFileName(file.originalname)) {
      accepted.push(file)
      continue
    }
    problems.push(
      createProblem('INVALID_FILE_NAME', {
        data: { file: displayFileName(file.originalname), max: MAX_FILE_NAME_LENGTH },
      }),
    )
  }
  return { accepted, problems }
}
