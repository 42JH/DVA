import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const scenarioId = /^[A-Z]{1,3}[0-9]{1,3}$/;
const versionTag = /^[1-9][0-9]*:[1-9][0-9]*$/;
export const personaCheckRunId = /^[0-9]{4}_[0-9]{6}_[0-9a-f]{6}$/;

export class PersonaCheckScenarioParams {
  @Matches(scenarioId)
  id!: string;
}

export class PersonaCheckRunParams {
  @Matches(personaCheckRunId)
  runId!: string;
}

export class PersonaCheckResultParams extends PersonaCheckRunParams {
  @Matches(scenarioId)
  scenario!: string;
}

export class PersonaCheckRunsQuery {
  @IsOptional()
  @MaxLength(64)
  @Matches(versionTag)
  tag?: string;
}

export class StartPersonaCheckRunDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @Matches(scenarioId, { each: true })
  scenarios?: string[];

  @IsString()
  @Length(1, 20000)
  @Matches(/\S/)
  promptText!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  voiceId?: string | null;

  @MaxLength(64)
  @Matches(versionTag)
  tag!: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt()
  @Min(1)
  concurrency?: number;
}
