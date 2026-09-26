import { isXmlText } from './xml-text.js'

/**
 * Tope de un nombre de archivo, en unidades UTF-16 (`String.length`, como lo cuenta el navegador en
 * `File.name`). Es el de los sistemas de archivos: NTFS y HFS+ admiten 255 unidades UTF-16; ext4 y
 * APFS, 255 bytes UTF-8, que nunca son más de 255 unidades. Ningún archivo real lo supera.
 */
export const MAX_FILE_NAME_LENGTH = 255

/** Un carácter de control de Unicode (categoría Cc): C0, DEL y C1. */
const CONTROL = /\p{Cc}/u

/**
 * Si `name` sirve como nombre de un archivo recibido: de 1 a `MAX_FILE_NAME_LENGTH` unidades UTF-16,
 * sin caracteres de control y solo con caracteres que XML admite (`isXmlText`: ni sustitutos sueltos
 * ni U+FFFE ni U+FFFF). Windows no admite controles en un nombre, y una persona no los escribe; el
 * navegador los manda escapados, pero multer devuelve el salto de línea y el retorno de carro.
 *
 * Acota lo que cuesta repetir el nombre: la API lo pone en `file` de cada problema de su archivo, y
 * de una factura con cien cuotas pueden salir unos doscientos. Un nombre así ocupa en UTF-8, y en
 * JSON, como mucho 3 bytes por unidad (767 con las comillas): JSON escapa `"` y `\` con 2 bytes, y
 * lo que escapa con 6 (controles y sustitutos sueltos) no está. La API lo exige a todo archivo antes
 * de leerlo; la landing, antes de enviarlo.
 */
export function isFileName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= MAX_FILE_NAME_LENGTH &&
    !CONTROL.test(name) &&
    isXmlText(name)
  )
}
