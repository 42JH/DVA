export type FaqQuestion={utteranceOrder:number;text:string};
export type FaqResult={eventId:string;occurredAt:string;questionUtteranceOrder:number;faqEntrySeqs:number[]};
export type FaqExamplesPayload={transactionId:string;questions:FaqQuestion[];results:FaqResult[]};
export function validateFaqExamples(value:unknown):asserts value is FaqExamplesPayload;
export type FaqChunksPayload={transactionId:string;chunkEventIds:string[]};
export function validateFaqChunks(value:unknown):asserts value is FaqChunksPayload;
export function splitFaqExamples(value:FaqExamplesPayload):FaqExamplesPayload[];
export function assembleFaqExamples(chunks:FaqExamplesPayload[],transactionId:string):FaqExamplesPayload;
