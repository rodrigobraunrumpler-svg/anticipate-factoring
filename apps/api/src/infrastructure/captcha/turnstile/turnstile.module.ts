import { Module } from '@nestjs/common'
import { CAPTCHA_VERIFIER } from '#/common/captcha/captcha-verifier.port.js'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { TurnstileCaptchaVerifier } from './turnstile-captcha-verifier.adapter.js'

/** Liga `CAPTCHA_VERIFIER` a Cloudflare Turnstile con la clave secreta de la configuración. */
@Module({
  providers: [
    {
      provide: CAPTCHA_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new TurnstileCaptchaVerifier({
          secretKey: config.turnstile.secretKey,
          expectedHostname: config.turnstile.expectedHostname,
        }),
    },
  ],
  exports: [CAPTCHA_VERIFIER],
})
export class TurnstileModule {}
