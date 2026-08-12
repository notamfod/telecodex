import WebSocket, { type RawData } from "ws";

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class AppServerClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private connected = false;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: AppServerNotification) => void>();

  constructor(private readonly socketPath: string) {}

  connect(): Promise<void> {
    if (this.connected) {
      return Promise.resolve();
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(buildSocketUrl(this.socketPath), { perMessageDeflate: false });
      this.socket = socket;

      const failConnect = (error: Error): void => {
        if (!this.connected) {
          this.connectPromise = null;
          reject(error);
        }
      };

      socket.on("message", (data) => this.handleMessage(data));
      socket.once("error", failConnect);
      socket.on("close", () => this.handleClose());
      socket.once("open", () => {
        this.sendRequest("initialize", {
          clientInfo: {
            name: "telecodex",
            title: "TeleCodex",
            version: "0.1.0",
          },
        })
          .then(() => {
            socket.off("error", failConnect);
            this.sendNotification("initialized", {});
            this.connected = true;
            resolve();
          })
          .catch(failConnect);
      });
    });

    return this.connectPromise;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.connected) {
      return this.sendRequest(method, params) as Promise<T>;
    }

    return this.connect().then(() => this.sendRequest(method, params) as Promise<T>);
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    this.rejectPending(new Error("App-server connection closed"));
  }

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextRequestId++;
    const message = params === undefined ? { method, id } : { method, id, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.send(message);
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  private send(message: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("App-server socket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(data: RawData): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(data.toString()) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message} (code ${message.error.code})`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method) {
      const notification: AppServerNotification = {
        method: message.method,
        ...(message.params === undefined ? {} : { params: message.params }),
      };
      for (const listener of this.notificationListeners) {
        listener(notification);
      }
    }
  }

  private handleClose(): void {
    this.socket = null;
    this.connected = false;
    this.connectPromise = null;
    this.rejectPending(new Error("App-server connection closed"));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

function buildSocketUrl(socketPath: string): string {
  return `ws+unix://${socketPath}:/rpc`;
}
