import { Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { ConsultationsRepository } from './consultations.repository';
import { CallQueryDto } from './dto/call-query.dto';
import { CallDetailDto } from './dto/call-response.dto';
import { TranscriptQueryDto } from './dto/transcript.dto';
import { RecordingPlaybackService } from './recording-playback.service';

@Injectable()
export class ConsultationsService {
  constructor(
    private readonly repository: ConsultationsRepository,
    private readonly playback: RecordingPlaybackService,
  ) {}

  async findMany(query: CallQueryDto) {
    const from = query.from === undefined ? undefined : Date.parse(query.from);
    const to = query.to === undefined ? undefined : Date.parse(query.to);
    if (
      (from !== undefined && !Number.isFinite(from)) ||
      (to !== undefined && !Number.isFinite(to)) ||
      (from !== undefined && to !== undefined && from >= to)
    )
      throw new ApiException(400, 'INVALID_REQUEST', '시작 시각은 종료 시각보다 빨라야 합니다.');
    return new ListResponse(await this.repository.findMany(query), query.limit);
  }

  async findOne(id: number): Promise<CallDetailDto> {
    const call = await this.repository.findOne(id);
    if (!call) throw new ApiException(404, 'NOT_FOUND', '통화 기록을 찾을 수 없습니다.');
    const recordings = await this.repository.findRecordings(id);
    return {
      call,
      recordings: await Promise.all(
        recordings.map(async ({ objectKey, ...recording }) => ({
          ...recording,
          ...(await this.playback.create(objectKey)),
        })),
      ),
    };
  }

  async findTranscript(id: number, query: TranscriptQueryDto) {
    if (!(await this.repository.findOne(id)))
      throw new ApiException(404, 'NOT_FOUND', '통화 기록을 찾을 수 없습니다.');
    return new ListResponse(await this.repository.findTranscript(id, query), query.limit);
  }
}
