import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import tls from 'node:tls'

/**
 * Certificado autofirmado de `127.0.0.1` (EC P-256, vence en 2126) y su clave. Solo sirve para que
 * los tests hablen HTTPS con un servidor local, como el cliente con R2 en producción.
 */
const STUB_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBkDCCATagAwIBAgIUNEwYHeHcRsxCf/AKzTz3be6LcOkwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDkyNTIxMzE0MFoYDzIxMjYwOTAx
MjEzMTQwWjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAT0DZNxopKdHTcU9H/n8Vm0eKMum2iQkEDav9WyilZYVfWWCKPLDysL
I3Mw58fiEk5Z8lU8eSSVBzdF6IADl93Zo2QwYjAdBgNVHQ4EFgQUDn63yJY2Ck/e
dXWFm1r+QlSe3gYwHwYDVR0jBBgwFoAUDn63yJY2Ck/edXWFm1r+QlSe3gYwDwYD
VR0RBAgwBocEfwAAATAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUC
IDH5asDlFflpK3ChdOXXXSD/RzZd/pUjy4XfvJOGc/BrAiEAiznksXeGTveQ/3jC
gqKviOQ/3pIZpjqmwxMYHFNetCo=
-----END CERTIFICATE-----
`

const STUB_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgOg3jc/qk/BuR806s
pykLFDCZN9J2qb6BFZ11JGKbV3uhRANCAAT0DZNxopKdHTcU9H/n8Vm0eKMum2iQ
kEDav9WyilZYVfWWCKPLDysLI3Mw58fiEk5Z8lU8eSSVBzdF6IADl93Z
-----END PRIVATE KEY-----
`

export type S3StubHandler = (req: IncomingMessage, res: ServerResponse) => void

export type S3StubServer = {
  readonly url: string
  /** Máximo de peticiones en curso a la vez que vio el servidor, por método HTTP. */
  maxInFlight(method?: string): number
  /** Peticiones que llegaron al servidor, por método HTTP: `0` prueba que el cliente no mandó nada. */
  requests(method?: string): number
  /** Cierra las conexiones abiertas, aunque tengan una respuesta a medias, y el servidor. */
  readonly stop: () => Promise<void>
}

/**
 * Servidor HTTP o HTTPS local que hace de proveedor S3 con las respuestas que programe el test.
 * Cuenta las peticiones en curso para comprobar cuántas manda el cliente a la vez. Con `tls`, los
 * tests llaman antes a `trustStubCertificate`.
 */
export async function startS3StubServer(
  handler: S3StubHandler,
  options: { tls?: boolean } = {},
): Promise<S3StubServer> {
  const current = new Map<string, number>()
  const peak = new Map<string, number>()
  const total = new Map<string, number>()
  const count = (method: string, delta: number) => {
    for (const key of [method, '*']) {
      const value = (current.get(key) ?? 0) + delta
      current.set(key, value)
      peak.set(key, Math.max(peak.get(key) ?? 0, value))
      if (delta > 0) total.set(key, (total.get(key) ?? 0) + delta)
    }
  }
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET'
    count(method, 1)
    res.once('close', () => count(method, -1))
    handler(req, res)
  }
  const server: Server = options.tls
    ? createHttpsServer({ cert: STUB_TLS_CERT, key: STUB_TLS_KEY }, listener)
    : createHttpServer(listener)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('sin puerto')
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${address.port}`,
    maxInFlight: (method = '*') => peak.get(method) ?? 0,
    requests: (method = '*') => total.get(method) ?? 0,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/**
 * Suma el certificado del servidor de prueba a las CA por defecto del proceso y devuelve cómo
 * restaurarlas. Las conexiones TLS nuevas lo usan sin tocar la configuración del cliente.
 */
export function trustStubCertificate(): () => void {
  const original = tls.getCACertificates('default')
  tls.setDefaultCACertificates([...original, STUB_TLS_CERT])
  return () => tls.setDefaultCACertificates(original)
}

/** Respuesta de `ListObjectsV2` con un bucket vacío. */
export function replyEmptyList(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/xml' })
  res.end(
    '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>stub</Name><KeyCount>0</KeyCount><MaxKeys>1</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>',
  )
}

/** Respuesta de `PutObject` exitosa. */
export function replyStored(res: ServerResponse): void {
  res.writeHead(200, { ETag: '"stub"' })
  res.end()
}

/** Respuesta de `DeleteObject` exitosa (también si el objeto no existía). */
export function replyDeleted(res: ServerResponse): void {
  res.writeHead(204)
  res.end()
}

/**
 * `503 SlowDown` con `Retry-After`: el SDK trata el error como reintentable y espera ese tiempo antes
 * del intento siguiente, sin mirar la señal de cancelación mientras espera.
 */
export function replySlowDown(res: ServerResponse, retryAfterSeconds: number): void {
  res.writeHead(503, {
    'Content-Type': 'application/xml',
    'Retry-After': String(retryAfterSeconds),
  })
  res.end(
    '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>',
  )
}
