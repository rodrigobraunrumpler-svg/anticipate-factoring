// Frontera del módulo para las demás capas (la persistencia de infrastructure). PayersModule no se
// exporta aquí: AppModule lo importa de su archivo, y así no se forma el ciclo
// payers.module → payers-persistence.module → este index → payers.module.
export {
  PAYER_REPOSITORY,
  type PayerRepositoryPort,
} from '#/modules/payers/application/ports/payer-repository.port.js'
export type { Payer } from '#/modules/payers/domain/types/payer.js'
