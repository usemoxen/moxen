/** The paired server on another machine a TUI is connected to (`server/transport/servers.ts`). */
export interface ActiveServer {
  readonly name: string;
  readonly host: string;
  readonly port: number;
}
