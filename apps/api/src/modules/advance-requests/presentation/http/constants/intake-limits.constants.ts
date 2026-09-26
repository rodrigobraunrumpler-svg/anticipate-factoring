/**
 * GET /api/v1/intake-limits: la misma caché pública que `GET /api/v1/payers`. Los topes cambian solo
 * con un despliegue, y la landing los pide junto con los pagadores.
 */
export const INTAKE_LIMITS_CACHE_CONTROL = 'public, max-age=300'
