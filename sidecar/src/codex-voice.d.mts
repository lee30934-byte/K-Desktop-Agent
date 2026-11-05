export class VoiceHost {
  constructor(codex: string, emit: (event: Record<string, unknown>) => void);
  receive(message: Record<string, unknown>): boolean;
  dispose(): void;
}
