import { type DynamicModule, Global, Module } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from './app-config.js'

/**
 * Provee la configuración ya validada como `APP_CONFIG` en toda la app. No usa `@nestjs/config`:
 * `main.ts` y los tests arman su `AppConfig` con `parseConfig` sin tocar `process.env` dentro de Nest.
 */
@Global()
@Module({})
export class AppConfigModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    }
  }
}
