export {}

declare global {
  namespace Express {
    interface Request {
      /** Id de correlación de la petición. Lo fija `CorrelationIdMiddleware` al entrar. */
      correlationId?: string
    }
  }
}
