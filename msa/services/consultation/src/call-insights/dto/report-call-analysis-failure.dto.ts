import { PickType } from '@nestjs/swagger';
import { CreateCallAnalysisDto } from './create-call-analysis.dto';

export class ReportCallAnalysisFailureDto extends PickType(
  CreateCallAnalysisDto,
  ['providerCallId'] as const,
) {}
