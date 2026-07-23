import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export class AppServerClient extends EventEmitter {
  constructor({
    command = "codex",
    args = ["app-server", "--stdio"],
    cwd = process.cwd(),
    env = process.env,
    requestTimeoutMs = 30_000,
    stderr = process.stderr,
  } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stderr = stderr;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
  }

  async start() {
    if (this.child) return;
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.on("data", (chunk) => this.stderr?.write(chunk));
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.acceptLine(line));
    this.child.on("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (code=${code}, signal=${signal ?? "none"}).`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    await new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
  }

  acceptLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error(`Invalid app-server JSONL: ${line.slice(0, 200)}`));
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const request = this.pending.get(String(message.id));
      if (!request) return;
      this.pending.delete(String(message.id));
      clearTimeout(request.timer);
      if (message.error) {
        request.reject(
          new Error(
            `Codex app-server ${request.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`,
          ),
        );
      } else {
        request.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit("request", message);
      return;
    }
    if (message.method) this.emit("notification", message);
  }

  send(message) {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server stdin is not writable.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = undefined) {
    const id = this.nextId++;
    const message = { id, method };
    if (params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Timed out waiting for app-server method '${method}'.`));
      }, this.requestTimeoutMs);
      this.pending.set(String(id), { method, resolve, reject, timer });
      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  notify(method, params = undefined) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.send(message);
  }

  respond(id, result) {
    this.send({ id, result });
  }

  respondError(id, code, message) {
    this.send({ id, error: { code, message } });
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.stdin.writable) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
