/**
 * Tarea del worker que lee XML: los bytes de un archivo y el tope de caracteres del lector. Solo
 * tipos, como `worker-pool.protocol.ts`: el worker los importa con `import type`.
 */
export type InvoiceXmlParseTask = { readonly xml: Uint8Array; readonly maxLength: number }
