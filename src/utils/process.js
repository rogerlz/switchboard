function killProcess(proc, signal = "SIGTERM") {
  if (!proc || proc.exitCode !== null) return;
  try {
    proc.kill(signal);
  } catch {
    // Process may already be dead
  }
}

// Signals the whole process group so grandchildren get reaped too.
function killProcessGroup(proc, signal = "SIGTERM") {
  if (!proc || proc.exitCode !== null) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    killProcess(proc, signal);
  }
}

const TIMEOUTS = {
  INSTALL: 300000, // 5 minutes for installations
};

module.exports = {
  killProcess,
  killProcessGroup,
  TIMEOUTS,
};
