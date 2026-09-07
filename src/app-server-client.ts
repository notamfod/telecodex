import WebSocket, { type RawData } from "ws";

export interface AppServerNotification {
  method: string;
  params?: unknown;
  emittedAtMs?: number;
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
  emittedAtMs?: unknown;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  writeState: WriteState;
  onWritten?: () => void;
}

type WriteState = "not_started" | "in_flight" | "written";

export type AppServerFailureCode =
  | "APP_SERVER_NOT_SENT"
  | "APP_SERVER_ACCEPTANCE_UNKNOWN"
  | "APP_SERVER_REJECTED";

export type AppServerRejectionReason = "THREAD_BUSY" | "THREAD_NOT_FOUND" | "OTHER";

export class AppServerRequestError extends Error {
  readonly name = "AppServerRequestError";

  constructor(
    readonly code: AppServerFailureCode,
    readonly rpcCode?: number,
    readonly reason?: AppServerRejectionReason,
  ) {
    super(messageForCode(code, rpcCode));
  }
}

export interface AppServerRequestOptions {
  timeoutMs?: number;
  /** Blocking durability barrier invoked immediately before transport write. */
  beforeSend?: () => void;
  onWritten?: () => void;
}

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TURN_START_TIMEOUT_MS = 30_000;
const CONNECTIVITY_TIMEOUT_MS = 5_000;

export interface AppServerClientTimeouts {
  readonly connectMs?: number;
  readonly requestMs?: number;
  readonly turnStartMs?: number;
}

export class AppServerClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private cancelConnect: (() => void) | null = null;
  private connected = false;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();
  private readonly disconnectListeners = new Set<() => void>();

  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly turnStartTimeoutMs: number;

  constructor(private readonly socketPath: string, timeouts: AppServerClientTimeouts = {}) {
    this.connectTimeoutMs = configuredTimeout(timeouts.connectMs, CONNECT_TIMEOUT_MS);
    this.requestTimeoutMs = configuredTimeout(timeouts.requestMs, REQUEST_TIMEOUT_MS);
    this.turnStartTimeoutMs = configuredTimeout(timeouts.turnStartMs, TURN_START_TIMEOUT_MS);
  }

  connect(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    let constructorFailed = false;
    const connecting = new Promise<void>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(buildSocketUrl(this.socketPath), { perMessageDeflate: false });
      } catch {
        constructorFailed = true;
        reject(transportError("not_started"));
        return;
      }
      this.socket = socket;
      let connectFailed = false;
      let connectSettled = false;
      let initializeWriteState: WriteState = "not_started";
      let cancelAttempt: () => void;

      const connectTimer = setTimeout(() => {
        failConnect(transportError(initializeWriteState));
      }, this.connectTimeoutMs);

      const rejectConnect = (error: Error): void => {
        if (connectSettled) return;
        connectFailed = true;
        connectSettled = true;
        clearTimeout(connectTimer);
        if (this.cancelConnect === cancelAttempt) this.cancelConnect = null;
        reject(error);
      };

      cancelAttempt = () => rejectConnect(transportError(initializeWriteState));
      this.cancelConnect = cancelAttempt;

      const failConnect = (error: Error): void => {
        rejectConnect(error);
        if (this.detachSocket(socket)) {
          this.notifyDisconnect();
          this.closeSocket(socket);
        }
      };

      const handleSocketError = (): void => {
        this.handleError(socket);
      };

      socket.on("message", (data) => this.handleMessage(socket, data));
      socket.on("error", handleSocketError);
      socket.on("close", () => {
        rejectConnect(transportError(initializeWriteState));
        this.handleClose(socket);
      });
      socket.once("open", () => {
        if (this.socket !== socket || connectSettled) {
          this.closeSocket(socket);
          return;
        }
        initializeWriteState = "in_flight";
        this.sendRequest("initialize", {
          clientInfo: {
            name: "telecodex",
            title: "TeleCodex",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        }, {
          timeoutMs: this.connectTimeoutMs,
          onWritten: () => {
            initializeWriteState = "written";
          },
        })
          .then(() => {
            if (connectFailed || this.socket !== socket) return;
            this.sendNotification("initialized", {});
            this.connected = true;
            connectSettled = true;
            clearTimeout(connectTimer);
            if (this.cancelConnect === cancelAttempt) this.cancelConnect = null;
            resolve();
          })
          .catch(failConnect);
      });
    });
    this.connectPromise = connecting;
    if (constructorFailed) {
      void connecting.catch(() => {
        if (this.connectPromise === connecting) this.connectPromise = null;
      });
    }
    return connecting;
  }

  request<T>(method: string, params?: unknown, options?: AppServerRequestOptions): Promise<T> {
    if (this.connected) {
      return this.sendRequest(method, params, options) as Promise<T>;
    }

    return this.connect().then(
      () => this.sendRequest(method, params, options) as Promise<T>,
      () => Promise.reject(transportError("not_started")),
    );
  }

  async checkConnectivity(timeoutMs = CONNECTIVITY_TIMEOUT_MS): Promise<void> {
    await this.request("server/diagnostics", {}, { timeoutMs });
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  close(): void {
    const socket = this.socket;
    if (!socket) {
      this.cancelConnect?.();
      this.cancelConnect = null;
      this.connectPromise = null;
      this.connected = false;
      this.rejectPending();
      return;
    }
    if (!this.detachSocket(socket)) return;
    this.notifyDisconnect();
    this.closeSocket(socket);
  }

  private sendRequest(
    method: string,
    params?: unknown,
    options?: AppServerRequestOptions,
  ): Promise<unknown> {
    const id = this.nextRequestId++;
    const message = params === undefined ? { method, id } : { method, id, params };
    let timeoutMs: number;
    try {
      timeoutMs = requestTimeout(
        method,
        options?.timeoutMs,
        this.requestTimeoutMs,
        this.turnStartTimeoutMs,
      );
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.takePending(id);
        if (pending) pending.reject(transportError(pending.writeState));
      }, timeoutMs);
      const pending: PendingRequest = {
        resolve,
        reject,
        timer,
        writeState: "not_started",
        ...(options?.onWritten ? { onWritten: options.onWritten } : {}),
      };
      this.pendingRequests.set(id, pending);
      try {
        options?.beforeSend?.();
      } catch (error) {
        this.takePending(id)?.reject(asError(error));
        return;
      }
      try {
        pending.writeState = "in_flight";
        this.send(message, (error?: Error) => {
          const current = this.pendingRequests.get(id);
          if (!current) return;
          if (error) {
            this.takePending(id)?.reject(transportError(current.writeState));
            return;
          }
          this.markWritten(current);
        });
      } catch {
        this.takePending(id)?.reject(transportError("not_started"));
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  private send(message: object, callback?: (error?: Error) => void): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw transportError("not_started");
    }
    this.socket.send(JSON.stringify(message), callback);
  }

  private handleMessage(socket: WebSocket, data: RawData): void {
    if (this.socket !== socket) return;
    let message: JsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(data.toString());
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      message = parsed as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.takePending(message.id);
      if (!pending) {
        return;
      }
      this.markWritten(pending);
      if (hasOwn(message, "method")) {
        pending.reject(transportError("written"));
        return;
      }
      const hasResult = hasOwn(message, "result");
      const hasError = hasOwn(message, "error");
      if (hasResult === hasError) {
        pending.reject(transportError("written"));
      } else if (hasResult) {
        pending.resolve(message.result);
      } else if (isJsonRpcError(message.error)) {
        pending.reject(rejectedError(message.error));
      } else {
        pending.reject(transportError("written"));
      }
      return;
    }

    if (typeof message.method === "string" && message.method.length > 0) {
      const notification: AppServerNotification = {
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
        ...(isUtcMilliseconds(message.emittedAtMs)
          ? { emittedAtMs: message.emittedAtMs }
          : {}),
      };
      for (const listener of this.notificationListeners) {
        listener(notification);
      }
    }
  }

  private handleClose(socket: WebSocket): void {
    if (!this.detachSocket(socket)) return;
    this.notifyDisconnect();
  }

  private handleError(socket: WebSocket): void {
    if (!this.detachSocket(socket)) return;
    this.notifyDisconnect();
    this.closeSocket(socket);
  }

  private detachSocket(socket: WebSocket): boolean {
    if (this.socket !== socket) return false;
    this.cancelConnect?.();
    this.cancelConnect = null;
    this.rejectPending();
    socket.removeAllListeners("message");
    socket.removeAllListeners("open");
    socket.removeAllListeners("close");
    socket.removeAllListeners("error");
    socket.on("error", ignoreSocketError);
    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    return true;
  }

  private closeSocket(socket: WebSocket): void {
    try {
      socket.close();
    } catch {
      // Socket ownership was already detached.
    }
  }

  private rejectPending(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(transportError(pending.writeState));
    }
    this.pendingRequests.clear();
  }

  private takePending(id: number): PendingRequest | undefined {
    const pending = this.pendingRequests.get(id);
    if (!pending) return undefined;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  private markWritten(pending: PendingRequest): void {
    if (pending.writeState === "written") return;
    pending.writeState = "written";
    try {
      pending.onWritten?.();
    } catch {
      // Observation callbacks must not change the RPC result or create an unhandled rejection.
    }
  }

  private notifyDisconnect(): void {
    for (const listener of [...this.disconnectListeners]) {
      try {
        listener();
      } catch {
        // A consumer cannot block transport teardown or later listeners.
      }
    }
  }
}

function buildSocketUrl(socketPath: string): string {
  return `ws+unix://${socketPath}:/rpc`;
}

function requestTimeout(
  method: string,
  configured: number | undefined,
  requestDefault = REQUEST_TIMEOUT_MS,
  turnStartDefault = TURN_START_TIMEOUT_MS,
): number {
  if (configured !== undefined) {
    if (!Number.isSafeInteger(configured) || configured <= 0 || configured > 2_147_483_647) {
      throw transportError("not_started");
    }
    return configured;
  }
  return method === "turn/start" ? turnStartDefault : requestDefault;
}

function configuredTimeout(value: number | undefined, fallback: number): number {
  const configured = value ?? fallback;
  if (!Number.isSafeInteger(configured) || configured <= 0 || configured > 2_147_483_647) {
    throw new Error("Invalid app-server timeout");
  }
  return configured;
}

function transportError(writeState: WriteState): AppServerRequestError {
  return new AppServerRequestError(
    writeState === "not_started"
      ? "APP_SERVER_NOT_SENT"
      : "APP_SERVER_ACCEPTANCE_UNKNOWN",
  );
}

interface JsonRpcError {
  code: number;
  message: string;
}

function rejectedError(error: JsonRpcError): AppServerRequestError {
  return new AppServerRequestError(
    "APP_SERVER_REJECTED",
    error.code,
    rejectionReason(error.message),
  );
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
  if (!isPlainObject(value)) return false;
  return Number.isSafeInteger(value.code) && typeof value.message === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isUtcMilliseconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function ignoreSocketError(): void {}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("App-server pre-send barrier failed");
}

function rejectionReason(message: string): AppServerRejectionReason {
  const normalized = message.replace(/ \(code -?\d+\)$/, "").trim().toLowerCase();
  if (
    normalized === "thread busy" ||
    normalized === "thread has an active turn" ||
    normalized === "turn is already running"
  ) {
    return "THREAD_BUSY";
  }
  if (/^thread not found(?::|$)/.test(normalized)) return "THREAD_NOT_FOUND";
  return "OTHER";
}

function messageForCode(code: AppServerFailureCode, rpcCode?: number): string {
  if (code === "APP_SERVER_NOT_SENT") return "App-server request was not sent";
  if (code === "APP_SERVER_ACCEPTANCE_UNKNOWN") {
    return "App-server request acceptance is unknown";
  }
  return Number.isSafeInteger(rpcCode)
    ? `App-server rejected request (RPC code ${rpcCode})`
    : "App-server rejected request";
}
