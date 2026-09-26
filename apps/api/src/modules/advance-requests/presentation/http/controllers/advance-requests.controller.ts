import type { AdvanceRequestCreated, AdvanceRequestForm } from '@anticipate/shared/advance-request'
import { SUCCESS_MESSAGES_ES } from '@anticipate/shared/api'
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { CaptchaGuard } from '#/common/captcha/captcha.guard.js'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { IDEMPOTENT_REPLAYED_HEADER } from '#/common/constants/http-headers.constants.js'
import { ResponseMessage } from '#/common/decorators/response-message.decorator.js'
import { SubmitThrottle } from '#/common/decorators/submit-throttle.decorator.js'
import { MultipartFilesInterceptor } from '#/common/interceptors/multipart-files.interceptor.js'
import { resolveClientIp } from '#/common/utils/client-ip.js'
import { resolveCorrelationId } from '#/common/utils/correlation-id.js'
import { CreateAdvanceRequestUseCase } from '#/modules/advance-requests/application/use-cases/create-advance-request.use-case.js'
import {
  ADVANCE_REQUEST_FILE_FIELDS,
  ADVANCE_REQUEST_FORM_FIELD,
  advanceRequestMultipartLimits,
} from '#/modules/advance-requests/presentation/http/constants/multipart.constants.js'
import { IdempotencyKey } from '#/modules/advance-requests/presentation/http/decorators/idempotency-key.decorator.js'
import type { AdvanceRequestUploadedFiles } from '#/modules/advance-requests/presentation/http/dto/create-advance-request.multipart.js'
import { toAdvanceRequestCreated } from '#/modules/advance-requests/presentation/http/mappers/advance-request-created.mapper.js'
import { AdvanceRequestFormPipe } from '#/modules/advance-requests/presentation/http/pipes/advance-request-form.pipe.js'
import {
  AdvanceRequestsApiTags,
  CreateAdvanceRequestDocs,
} from '#/modules/advance-requests/presentation/http/swagger/advance-requests.swagger.js'

/**
 * Único endpoint público de escritura. El orden lo pone Nest: `ContentLengthLimitMiddleware`
 * (módulo), `AppThrottlerGuard` (global, con `@SubmitThrottle()`), `CaptchaGuard`, multer, el pipe
 * de `form`, `@IdempotencyKey()` y el caso de uso.
 */
@AdvanceRequestsApiTags()
@Controller({ path: 'advance-requests', version: '1' })
export class AdvanceRequestsController {
  constructor(
    @Inject(CreateAdvanceRequestUseCase)
    private readonly createAdvanceRequest: CreateAdvanceRequestUseCase,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @HttpCode(201)
  @SubmitThrottle()
  @UseGuards(CaptchaGuard)
  @UseInterceptors(
    MultipartFilesInterceptor(ADVANCE_REQUEST_FILE_FIELDS, advanceRequestMultipartLimits),
  )
  @ResponseMessage(SUCCESS_MESSAGES_ES.advanceRequestCreated)
  @CreateAdvanceRequestDocs()
  async create(
    @Body(ADVANCE_REQUEST_FORM_FIELD, AdvanceRequestFormPipe) form: AdvanceRequestForm,
    @IdempotencyKey() idempotencyKey: string,
    @UploadedFiles() files: AdvanceRequestUploadedFiles | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdvanceRequestCreated> {
    const result = await this.createAdvanceRequest.execute({
      form,
      xmlFiles: files?.xml ?? [],
      pdfFiles: files?.pdf ?? [],
      idempotencyKey,
      clientIp: resolveClientIp(request, this.config.trustCloudflareHeaders),
      userAgent: request.get('user-agent') ?? null,
      correlationId: resolveCorrelationId(request),
    })
    if (result.replayed) response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true')
    return toAdvanceRequestCreated(result)
  }
}
