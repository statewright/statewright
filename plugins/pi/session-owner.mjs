import { SessionManager } from "@mariozechner/pi-coding-agent";

// Keep SDK resolution at the Pi package boundary (the SDK is ESM-only).
export function createPiSessionDescriptor({ cwd, sessionDir, sessionId }) {
  const manager = SessionManager.create(cwd, sessionDir);
  manager.newSession({ id: sessionId });
  return { sessionFile: manager.getSessionFile(), header: manager.getHeader() };
}
