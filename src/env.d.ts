declare global {
  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
    run(): Promise<{ success: boolean }>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
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
    json<T = unknown>(): Promise<T>;
    text(): Promise<string>;
  }

  declare class Request {
    readonly url: string;
    readonly method: string;
    json<T = unknown>(): Promise<T>;
    text(): Promise<string>;
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