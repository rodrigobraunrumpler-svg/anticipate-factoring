import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

type PackageJson = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageJson

describe('dependencias de @anticipate/emails en tiempo de ejecución', () => {
  it('solo @react-email/render, react y react-dom: react-email no entra en la imagen de la API', () => {
    // react-email es monolítico (CLI, servidor de vista previa, tailwindcss, socket.io, esbuild):
    // como dependencia de producción sumaba unos 55 MB y 100 paquetes a la imagen de la API. Es de
    // desarrollo y tsdown mete en dist solo los componentes que usan las plantillas.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@react-email/render',
      'react',
      'react-dom',
    ])
    expect(manifest.devDependencies).toHaveProperty('react-email')
  })
})
