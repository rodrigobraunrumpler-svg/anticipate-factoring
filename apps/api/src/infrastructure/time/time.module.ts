import { Global, Module } from '@nestjs/common'
import { CLOCK } from '#/common/time/clock.js'
import { SystemClock } from './system-clock.js'

/** Provee `CLOCK` en toda la app con el reloj del sistema. */
@Global()
@Module({
  providers: [{ provide: CLOCK, useClass: SystemClock }],
  exports: [CLOCK],
})
export class TimeModule {}
