import { Global, Module } from '@nestjs/common'
import { OUTBOX_WAKE_UP, OutboxWakeUpSignal } from './application/services/outbox-wake-up.signal.js'

/**
 * Global: solo provee la señal de despertar. Los casos de uso los cablea la raíz de composición
 * (`workers/outbox-publisher`), que conoce los handlers. `useFactory` da una señal por app: dos apps
 * en el mismo proceso (los tests) no comparten suscriptores.
 */
@Global()
@Module({
  providers: [{ provide: OUTBOX_WAKE_UP, useFactory: () => new OutboxWakeUpSignal() }],
  exports: [OUTBOX_WAKE_UP],
})
export class OutboxModule {}
