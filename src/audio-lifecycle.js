export const AUDIO_START_TIMEOUT_MS = 8000;
const RECOVERY_OPERATION_TIMEOUT_MS = 1200;
const RECOVERY_CLOCK_TEST_MS = 250;
const MINIMUM_CLOCK_ADVANCE_SECONDS = .05;

function waitForAudio(promise, signal, milliseconds = null) {
  return new Promise((resolve, reject) => {
    let remaining = milliseconds;
    let since = null;
    let timer = null;
    const finish = (settle, value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      document.removeEventListener('visibilitychange', visibility);
      settle(value);
    };
    const abort = () => finish(reject, signal.reason);
    const visibility = () => {
      clearTimeout(timer);
      if (since !== null) remaining -= performance.now() - since;
      since = null;
      if (remaining !== null && document.visibilityState === 'visible') {
        since = performance.now();
        timer = setTimeout(() => finish(reject, new Error('Audio did not start. Try Play or Recover audio.')), Math.max(0, remaining));
      }
    };
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    if (remaining !== null) {
      document.addEventListener('visibilitychange', visibility);
      visibility();
    }
  });
}

export function createAudioLifecycle({ onChange = () => {}, onInterrupted = () => {} } = {}) {
  let context = null;
  let pending = null;
  let playing = false;
  let detachContext = null;

  function retire() {
    const old = context;
    context = null;
    detachContext?.();
    detachContext = null;
    if (old && old.state !== 'closed') old.close().catch(() => {});
  }

  function cancel() {
    const old = pending;
    pending = null;
    old?.abort();
    playing = false;
    retire();
    onChange();
  }

  function interrupt() {
    if (!playing) return;
    cancel();
    onInterrupted();
  }

  function get() {
    if (context?.state === 'closed') retire();
    if (!context) {
      const created = new AudioContext();
      context = created;
      const changed = () => { if (context === created && created.state !== 'running') interrupt(); };
      created.addEventListener('statechange', changed);
      detachContext = () => created.removeEventListener('statechange', changed);
    }
    return context;
  }

  const wake = () => {
    if (document.visibilityState === 'visible' && context?.state !== 'running') interrupt();
  };
  const sessionChanged = () => { if (navigator.audioSession?.state === 'interrupted') interrupt(); };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  navigator.audioSession?.addEventListener('statechange', sessionChanged);

  function begin({ kind = 'play', fresh = false } = {}) {
    if (pending || fresh) cancel();
    const controller = new AbortController();
    const task = {
      kind,
      context: null,
      ready: null,
      signal: controller.signal,
      abort: () => controller.abort(),
      current: () => pending === task && !controller.signal.aborted,
      wait: (promise, milliseconds = null) => waitForAudio(promise, controller.signal, milliseconds),
      cancel: () => { if (task.current()) cancel(); },
      finish() {
        if (!task.current()) return false;
        pending = null;
        controller.abort();
        onChange();
        return true;
      }
    };
    pending = task;
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      task.context = get();
      task.ready = task.wait(task.context.resume(), kind === 'recover' ? RECOVERY_OPERATION_TIMEOUT_MS : AUDIO_START_TIMEOUT_MS);
    } catch (error) {
      task.ready = Promise.reject(error);
    }
    task.ready.catch(() => {});
    onChange();
    return task;
  }

  async function clockAdvances(task) {
    const owned = task.context;
    task.signal.throwIfAborted();
    if (owned.state === 'closed') return false;
    const oscillator = owned.createOscillator();
    const gain = owned.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(owned.destination);
    const startedAt = owned.currentTime;
    oscillator.start();
    let timer;
    try {
      await task.wait(new Promise(resolve => { timer = setTimeout(resolve, RECOVERY_CLOCK_TEST_MS); }));
      return owned.state === 'running' && owned.currentTime - startedAt >= MINIMUM_CLOCK_ADVANCE_SECONDS;
    } finally {
      clearTimeout(timer);
      try { oscillator.stop(); } catch {}
      oscillator.disconnect();
      gain.disconnect();
    }
  }

  async function recover(task) {
    try { await task.ready; } catch (error) {
      task.signal.throwIfAborted();
      if (!task.context) throw error;
    }
    // Safari may stall resume's promise even when its audio clock is running.
    if (await clockAdvances(task)) return;
    await task.wait(task.context.suspend(), RECOVERY_OPERATION_TIMEOUT_MS);
    await task.wait(task.context.resume(), RECOVERY_OPERATION_TIMEOUT_MS);
    if (!await clockAdvances(task)) throw new Error(`Audio clock did not recover (state: ${task.context.state}).`);
  }

  return {
    get,
    begin,
    recover,
    cancel,
    pending: () => pending,
    markPlaying(owned) {
      if (owned !== context || owned.state !== 'running') throw new Error('Audio is interrupted. Try Play or Recover audio.');
      playing = true;
    },
    release(owned) { if (owned === context) cancel(); },
    dispose() {
      cancel();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
      navigator.audioSession?.removeEventListener('statechange', sessionChanged);
    }
  };
}
