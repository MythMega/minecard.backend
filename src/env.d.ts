declare global {
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
  }

  interface HeadersInit {}
  interface BodyInit {}

  interface ResponseInit {
    status?: number;
    statusText?: string;
    headers?: Record<string, string> | HeadersInit;
  }

  declare class Response {
    constructor(body?: BodyInit | null, init?: ResponseInit);
    readonly ok: boolean;
    readonly status: number;
    readonly headers: { get(name: string): string | null };
    readonly body: unknown;
    json<T = unknown>(): Promise<T>;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  declare class Request {
    readonly url: string;
    readonly method: string;
    readonly headers: { get(name: string): string | null };
    json<T = unknown>(): Promise<T>;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }

  declare class TextEncoder {
    encode(input?: string): Uint8Array;
  }

  declare class TextDecoder {
    constructor(label?: string);
    decode(input?: ArrayBuffer | Uint8Array): string;
  }

  interface URLSearchParams {
    get(name: string): string | null;
  }

  declare class URL {
    constructor(url: string, base?: string);
    readonly pathname: string;
    readonly searchParams: URLSearchParams;
  }

  const console: {
    log(...data: unknown[]): void;
    error(...data: unknown[]): void;
    warn(...data: unknown[]): void;
  };
}

export {};