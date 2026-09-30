export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
export class GenerationError extends Error {
  uncertain: boolean;
  constructor(uncertain: boolean) { super('AI service unavailable'); this.uncertain = uncertain; }
}
