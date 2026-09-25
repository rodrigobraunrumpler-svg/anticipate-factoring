/** GET /api/v1/payers: la landing y la CDN pueden reutilizar la lista durante cinco minutos. */
export const PUBLIC_PAYERS_CACHE_CONTROL = 'public, max-age=300'
