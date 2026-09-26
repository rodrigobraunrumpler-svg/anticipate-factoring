/**
 * XML hostil de la revisión de la Tarea 11: `size` bytes (1 MiB por defecto) de etiquetas vacías con
 * nombres distintos (`<t0/><t1/>…`) dentro de `Invoice`. Es XML válido que el lector de shared tarda
 * medio segundo o más en recorrer y que necesita unos 60 MiB de heap; sin serie ni fecha, termina en
 * `XML_MISSING_REQUIRED_FIELD`.
 */
export function hostileInvoiceXml(size = 1024 * 1024): Buffer {
  const head = '<?xml version="1.0" encoding="UTF-8"?><Invoice>'
  const tail = '</Invoice>'
  const parts = [head]
  let length = head.length + tail.length
  for (let i = 0; ; i++) {
    const tag = `<t${i}/>`
    if (length + tag.length > size) break
    parts.push(tag)
    length += tag.length
  }
  parts.push(tail)
  return Buffer.from(parts.join(''), 'utf8')
}
