import { Module } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { INVOICE_XML_PARSER } from '#/modules/advance-requests/index.js'
import { WorkerThreadsInvoiceXmlParser } from './worker-threads-invoice-xml-parser.adapter.js'

/**
 * Liga `INVOICE_XML_PARSER` al pool de `worker_threads` con los topes `XML_PARSE_*`. El adaptador
 * arranca un hilo en `onModuleInit` (un script que no carga detiene el arranque) y termina todos en
 * `onApplicationShutdown`, el último hook de Nest: para entonces el servidor HTTP ya no atiende.
 */
@Module({
  providers: [
    {
      provide: INVOICE_XML_PARSER,
      inject: [APP_CONFIG],
      useFactory: ({ xmlParser }: AppConfig) => new WorkerThreadsInvoiceXmlParser(xmlParser),
    },
  ],
  exports: [INVOICE_XML_PARSER],
})
export class InvoiceXmlParserModule {}
