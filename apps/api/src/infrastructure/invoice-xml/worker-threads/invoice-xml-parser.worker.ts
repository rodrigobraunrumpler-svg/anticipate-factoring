/**
 * Worker del lector de XML de facturas (`WorkerThreadsInvoiceXmlParser`). Corre la misma lectura que
 * antes corría en el hilo principal, `parseUblInvoice(decodeXml(bytes), { maxLength })`, y devuelve su
 * resultado sin tocarlo.
 *
 * Node carga este archivo directamente, sin Vite: en los tests desde `src` (Node quita los tipos; hace
 * falta Node >= 22.18, y el repositorio exige 24.15) y en producción desde `dist`. Por eso en ejecución
 * solo importa paquetes y `node:`: un import relativo (`./x.js`) no existe en `src`, donde el archivo
 * es `.ts`. Lo propio va con `import type`, que se borra entero, y sin sintaxis de TypeScript que no
 * se pueda borrar (enums, propiedades de parámetro).
 */

import { parentPort } from 'node:worker_threads'
import type { ParseResult } from '@anticipate/shared/invoice'
import { decodeXml, parseUblInvoice } from '@anticipate/shared/invoice'
import type { InvoiceXmlParseTask } from './invoice-xml-parser.protocol.js'
import type { WorkerReply, WorkerRequest } from './worker-pool.protocol.js'

const port = parentPort
if (port === null) throw new Error('invoice-xml-parser.worker solo corre dentro de un WorkerPool')

port.on('message', ({ id, input }: WorkerRequest<InvoiceXmlParseTask>) => {
  let reply: WorkerReply<ParseResult>
  try {
    const result = parseUblInvoice(decodeXml(input.xml), { maxLength: input.maxLength })
    reply = { kind: 'result', id, value: result }
  } catch (error) {
    // `parseUblInvoice` no lanza por el contenido de un XML: esto es un defecto, y el pool lo rechaza
    // como tal (500), nunca como un problema del proveedor.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    reply = { kind: 'failure', id, message }
  }
  port.postMessage(reply)
})

port.postMessage({ kind: 'ready' } satisfies WorkerReply<ParseResult>)
