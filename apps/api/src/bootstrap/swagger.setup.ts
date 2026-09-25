import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { API_DEFAULT_VERSION, SWAGGER_PATH } from './constants.js'

/**
 * Documento OpenAPI en `/docs` (y el JSON en `/docs-json`). Quien llama decide el entorno: `setupApp`
 * solo lo monta fuera de producción.
 */
export function setupSwagger(app: NestExpressApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Anticipate API')
      .setDescription(
        'API de Anticipate Factoring: solicitudes de adelanto, pagadores y sondas de salud.',
      )
      .setVersion(API_DEFAULT_VERSION)
      .build(),
  )
  SwaggerModule.setup(SWAGGER_PATH, app, document, { raw: ['json'] })
}
