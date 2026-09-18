// Test-only bounded IPC/exit observation, shared by actual owned processes.
export function ownedProcessDriver(child, { schema, timeoutMs = 15_000 }) {
  const inbox = [];
  const waiting = new Set();
  let output = "";
  let exited = false;
  child.stdout.on("data", chunk => { output = (output + chunk).slice(-8192); });
  child.stderr.on("data", chunk => { output = (output + chunk).slice(-8192); });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exited = true;
      for (const waiter of waiting) waiter.reject(new Error(`Owned child exited ${code}/${signal}: ${output}`));
      resolve({ code, signal });
    });
  });
  exit.catch(() => {});
  child.on("message", message => {
    if (message?.schema !== schema || message.pid !== child.pid) return;
    for (const waiter of waiting) {
      if (message.type === "failure") waiter.reject(new Error(message.error));
      else if (waiter.type === message.type) { waiter.resolve(message); return; }
    }
    inbox.push(message);
  });
  const wait = type => new Promise((resolve, reject) => {
    const failure = inbox.find(value => value.type === "failure");
    if (failure) { reject(new Error(failure.error)); return; }
    const index = inbox.findIndex(value => value.type === type);
    if (index >= 0) { resolve(inbox.splice(index, 1)[0]); return; }
    if (exited) { reject(new Error(`Owned child already exited: ${output}`)); return; }
    const waiter = { type, resolve: value => { clearTimeout(timer); waiting.delete(waiter); resolve(value); },
      reject: error => { clearTimeout(timer); waiting.delete(waiter); reject(error); } };
    const timer = setTimeout(() => waiter.reject(new Error(`Owned child ${type} timeout: ${output}`)), timeoutMs);
    waiting.add(waiter);
  });
  const send = (type, value = {}) => child.send({ schema, type, ...value });
  const awaitExit = async deadlineMs => {
    let timer;
    try {
      return await Promise.race([exit, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Owned exit observation timed out: ${output}`)), deadlineMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const close = async ({ deadlineMs = timeoutMs } = {}) => {
    if (exited) return exit;
    send("close");
    return awaitExit(deadlineMs);
  };
  const terminate = async ({ graceMs = 500, killMs = 1_000 } = {}) => {
    if (exited) return exit;
    child.kill("SIGTERM"); // Exact task-owned handle, never a PID search/adoption.
    try { return await awaitExit(graceMs); }
    catch {
      if (exited) return exit;
      child.kill("SIGKILL");
      // A deadline is not proof of exit: require the actual exit event or fail.
      return awaitExit(killMs);
    }
  };
  return { child, wait, send, close, terminate, exit, get exited() { return exited; } };
}
