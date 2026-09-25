import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { AppModule, type ExtraModules } from '#/app.module.js'
import { NEST_APP_OPTIONS, setupApp } from '#/app.setup.js'
import { CLOCK, type Clock } from '#/common/time/clock.js'
import { testConfig } from './config.js'
import { MutableClock } from './fakes.js'

/** "Ahora" de los tests: 10:00 del 24 de septiembre de 2026 en Lima. */
export const TEST_NOW = new Date('2026-09-24T15:00:00.000Z')

export type TestAppOptions = {
  /** Variables que cambian respecto de `testEnv()`. */
  env?: Readonly<Record<string, string | undefined>>
  /** Instante del reloj fijo. Por defecto, `TEST_NOW`. */
  now?: Date
  /** Reloj propio, para tests que mueven el tiempo. Tiene prioridad sobre `now`. */
  clock?: Clock
  /** Pares [token, instancia] que reemplazan proveedores (captcha, correo, almacenamiento). */
  overrides?: ReadonlyArray<readonly [token: unknown, value: unknown]>
  /** Módulos extra, por ejemplo un controlador de prueba. */
  extraModules?: ExtraModules
}

/**
 * La app completa con la misma `setupApp` que producción; solo cambia cómo se arma el módulo (con
 * `@nestjs/testing`, para poder reemplazar proveedores). `src` nunca importa `@nestjs/testing`.
 */
export async function createTestApp(options: TestAppOptions = {}): Promise<NestExpressApplication> {
  const config = testConfig(options.env)
  const clock = options.clock ?? new MutableClock(options.now ?? TEST_NOW)
  let builder = Test.createTestingModule({
    imports: [AppModule.register(config, options.extraModules)],
  })
    .overrideProvider(CLOCK)
    .useValue(clock)
  for (const [token, value] of options.overrides ?? []) {
    builder = builder.overrideProvider(token).useValue(value)
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>(NEST_APP_OPTIONS)
  try {
    setupApp(app, config)
    await app.init()
  } catch (error) {
    await app.close()
    throw error
  }
  return app
}
