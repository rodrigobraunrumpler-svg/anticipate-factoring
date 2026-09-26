import { describe, expect, it } from 'vitest'
import {
  type IntakeLimits,
  intakeCapacityShortfalls,
  intakeLimitsSchema,
  MAX_FORM_FIELD_BYTES,
  MULTIPART_PART_OVERHEAD_BYTES,
  submissionBodyBytesUpperBound,
  tooManyFilesMessage,
} from './intake-limits.js'

/** Los topes por defecto de la API (`UPLOAD_MAX_*` en `apps/api/.env.example`). */
const DEFAULTS: IntakeLimits = {
  maxFiles: 20,
  maxXmlBytes: 1_048_576,
  maxPdfBytes: 10_485_760,
  maxBodyBytes: 95_000_000,
}

describe('intakeLimitsSchema', () => {
  it('acepta los cuatro topes enteros y positivos', () => {
    expect(intakeLimitsSchema.parse(DEFAULTS)).toEqual(DEFAULTS)
  })

  it.each([
    ['un tope en cero', { ...DEFAULTS, maxFiles: 0 }],
    ['un tope con decimales', { ...DEFAULTS, maxPdfBytes: 1.5 }],
    ['un tope como texto', { ...DEFAULTS, maxBodyBytes: '95000000' }],
    ['un tope que falta', { maxFiles: 20, maxXmlBytes: 1, maxPdfBytes: 1 }],
    ['una propiedad de más', { ...DEFAULTS, maxInflightBytes: 190_000_000 }],
  ])('rechaza %s', (_label, value) => {
    expect(intakeLimitsSchema.safeParse(value).success).toBe(false)
  })
})

describe('submissionBodyBytesUpperBound', () => {
  it('suma los archivos, lo que el multipart agrega a cada parte, el formulario más largo y el cierre', () => {
    const fixed = MAX_FORM_FIELD_BYTES + 2 * MULTIPART_PART_OVERHEAD_BYTES
    expect(submissionBodyBytesUpperBound([])).toBe(fixed)
    expect(submissionBodyBytesUpperBound([100, 200])).toBe(
      fixed + 300 + 2 * MULTIPART_PART_OVERHEAD_BYTES,
    )
  })

  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'un tamaño inválido (%s) es un error de programación',
    (size) => {
      expect(() => submissionBodyBytesUpperBound([10, size])).toThrow(RangeError)
    },
  )

  it('es una cota real del cuerpo que arma un cliente, con nombres de 255 caracteres de 3 bytes y comillas', async () => {
    // El peor caso de las cabeceras de una parte: un nombre de 255 unidades UTF-16, todas de 3 bytes
    // en UTF-8 o escapadas como %22. El formulario, del largo máximo.
    const longName = (extension: string) =>
      `${'€'.repeat(120)}${'"'.repeat(255 - 120 - extension.length)}${extension}`
    const files = [
      { field: 'xml', name: longName('.xml'), size: 3_000 },
      { field: 'pdf', name: longName('.pdf'), size: 5_000 },
      { field: 'xml', name: longName('.xml'), size: 0 },
    ]
    const body = new FormData()
    body.append('form', 'x'.repeat(MAX_FORM_FIELD_BYTES))
    for (const file of files) {
      body.append(file.field, new Blob([new Uint8Array(file.size)]), file.name)
    }
    const serialized = await new Request('http://localhost/', {
      method: 'POST',
      body,
    }).arrayBuffer()
    const bound = submissionBodyBytesUpperBound(files.map((file) => file.size))
    expect(serialized.byteLength).toBeLessThanOrEqual(bound)
  })
})

describe('intakeCapacityShortfalls', () => {
  it('con los topes por defecto, diez facturas con su PDF entran', () => {
    expect(intakeCapacityShortfalls(10, DEFAULTS)).toEqual([])
  })

  it('pide el doble de archivos que facturas: cada factura puede traer su XML y su PDF', () => {
    expect(intakeCapacityShortfalls(15, DEFAULTS)).toEqual([
      { limit: 'maxFiles', current: 20, required: 30 },
    ])
    expect(intakeCapacityShortfalls(10, { ...DEFAULTS, maxFiles: 19 })).toEqual([
      { limit: 'maxFiles', current: 19, required: 20 },
    ])
  })

  it('pide que el cuerpo reciba cada XML del tamaño máximo más las partes de sus PDF', () => {
    const required = submissionBodyBytesUpperBound([
      ...Array<number>(100).fill(DEFAULTS.maxXmlBytes),
      ...Array<number>(100).fill(0),
    ])
    expect(required).toBeGreaterThan(DEFAULTS.maxBodyBytes)
    expect(intakeCapacityShortfalls(100, DEFAULTS)).toEqual([
      { limit: 'maxFiles', current: 20, required: 200 },
      { limit: 'maxBodyBytes', current: 95_000_000, required },
    ])
  })

  it('justo en el límite no falta nada', () => {
    const maxBodyBytes = submissionBodyBytesUpperBound([
      ...Array<number>(10).fill(DEFAULTS.maxXmlBytes),
      ...Array<number>(10).fill(0),
    ])
    expect(intakeCapacityShortfalls(10, { ...DEFAULTS, maxFiles: 20, maxBodyBytes })).toEqual([])
    expect(intakeCapacityShortfalls(10, { ...DEFAULTS, maxBodyBytes: maxBodyBytes - 1 })).toEqual([
      { limit: 'maxBodyBytes', current: maxBodyBytes - 1, required: maxBodyBytes },
    ])
  })

  it('el peso de los PDF no cuenta: lo revisa la landing contra maxBodyBytes antes de enviar', () => {
    expect(intakeCapacityShortfalls(10, { ...DEFAULTS, maxPdfBytes: 100 * 1024 * 1024 })).toEqual(
      [],
    )
  })

  it.each([[0], [-3], [2.5], [Number.NaN]])(
    'un máximo de facturas inválido (%s) lanza',
    (value) => {
      expect(() => intakeCapacityShortfalls(value, DEFAULTS)).toThrow(RangeError)
    },
  )
})

describe('tooManyFilesMessage', () => {
  it('dice cuántos archivos admite la solicitud y qué hacer', () => {
    expect(tooManyFilesMessage(20)).toBe(
      'Adjuntaste más archivos de los permitidos: puedes enviar hasta 20 archivos por solicitud, entre XML y PDF. Quita los que sobran o envía las demás facturas en otra solicitud.',
    )
  })

  it.each([[0], [1.5]])('un tope inválido (%s) lanza', (value) => {
    expect(() => tooManyFilesMessage(value)).toThrow(RangeError)
  })
})
