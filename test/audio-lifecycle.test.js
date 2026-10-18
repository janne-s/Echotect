import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { AUDIO_START_TIMEOUT_MS, createAudioLifecycle } from '../src/audio-lifecycle.js';

const browserDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
const browserWindow = new EventTarget();
const session = Object.assign(new EventTarget(), { type: 'auto', state: 'active' });
globalThis.document = browserDocument;
globalThis.window = browserWindow;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { audioSession: session } });

class AudioNode {
  constructor() { this.gain = { value: 1 }; this.connected = false; this.stopped = false; }
  connect(node) { this.connected = true; return node; }
  disconnect() { this.connected = false; }
  start() {}
  stop() { this.stopped = true; }
}

class AudioContext extends EventTarget {
  static instances = [];
  static resume = context => { context.state = 'running'; return Promise.resolve(); };
  static close = context => { context.change('closed'); return Promise.resolve(); };
  constructor() {
    super();
    this.state = 'suspended';
    this.currentTime = 0;
    this.resumeCalls = 0;
    this.suspendCalls = 0;
    this.destination = {};
    this.nodes = [];
    AudioContext.instances.push(this);
  }
  resume() { this.resumeCalls += 1; return AudioContext.resume(this); }
  suspend() { this.suspendCalls += 1; this.change('suspended'); return Promise.resolve(); }
  close() { return AudioContext.close(this); }
  change(state) { this.state = state; this.dispatchEvent(new Event('statechange')); }
  createOscillator() { const node = new AudioNode(); this.nodes.push(node); return node; }
  createGain() { const node = new AudioNode(); this.nodes.push(node); return node; }
}
globalThis.AudioContext = AudioContext;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

beforeEach(t => {
  browserDocument.visibilityState = 'visible';
  session.state = 'active';
  navigator.audioSession = session;
  AudioContext.instances = [];
  AudioContext.resume = context => { context.state = 'running'; return Promise.resolve(); };
  AudioContext.close = context => { context.change('closed'); return Promise.resolve(); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
});

function lifecycleFor(t, options) {
  const audio = createAudioLifecycle(options);
  t.after(() => audio.dispose());
  return audio;
}

test('Play activates the context and playback session before any asynchronous preparation', async t => {
  const audio = lifecycleFor(t);
  assert.equal(AudioContext.instances.length, 0);
  const task = audio.begin();
  assert.equal(task.context.resumeCalls, 1);
  assert.equal(session.type, 'playback');
  await task.ready;
  audio.markPlaying(task.context);
  assert.equal(task.finish(), true);
  audio.release(task.context);
  assert.equal(task.context.state, 'closed');
});

test('cancelling a pending resume rejects immediately and a late completion cannot affect its replacement', async t => {
  const audio = lifecycleFor(t);
  const resume = deferred();
  AudioContext.resume = () => resume.promise;
  const old = audio.begin();
  const cancelled = assert.rejects(old.ready, { name: 'AbortError' });
  old.cancel();
  await cancelled;
  AudioContext.resume = context => { context.state = 'running'; return Promise.resolve(); };
  const next = audio.begin();
  await next.ready;
  resume.resolve();
  await flush();
  old.cancel();
  assert.equal(old.current(), false);
  assert.equal(next.current(), true);
  assert.equal(old.context.state, 'closed');
  assert.equal(next.context.state, 'running');
});

test('a failed obsolete preparation cannot clear a newer operation', async t => {
  const audio = lifecycleFor(t);
  const old = audio.begin();
  await old.ready;
  const preparation = deferred();
  const waiting = old.wait(preparation.promise);
  const cancelled = assert.rejects(waiting, { name: 'AbortError' });
  const next = audio.begin();
  await next.ready;
  preparation.reject(new Error('old render failed'));
  await cancelled;
  assert.equal(old.finish(), false);
  old.cancel();
  assert.equal(next.current(), true);
  assert.throws(() => audio.markPlaying(old.context), /interrupted/);
});

test('resume deadline excludes hidden time and stops waiting after eight visible seconds', async t => {
  const audio = lifecycleFor(t);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  AudioContext.resume = () => new Promise(() => {});
  const task = audio.begin();
  let failed = false;
  const timeout = assert.rejects(task.ready, /Audio did not start/).then(() => { failed = true; });
  now = 3000;
  t.mock.timers.tick(3000);
  browserDocument.visibilityState = 'hidden';
  browserDocument.dispatchEvent(new Event('visibilitychange'));
  now += 60000;
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(failed, false);
  browserDocument.visibilityState = 'visible';
  browserDocument.dispatchEvent(new Event('visibilitychange'));
  now += AUDIO_START_TIMEOUT_MS - 3001;
  t.mock.timers.tick(AUDIO_START_TIMEOUT_MS - 3001);
  await flush();
  assert.equal(failed, false);
  now += 1;
  t.mock.timers.tick(1);
  await timeout;
  task.cancel();
  assert.equal(audio.pending(), null);
  assert.equal(task.context.state, 'closed');
});

test('normal resume rejection is observable even when preparation has not attached a handler yet', async t => {
  const audio = lifecycleFor(t);
  AudioContext.resume = () => Promise.reject(new Error('Output unavailable'));
  const task = audio.begin();
  await flush();
  await assert.rejects(task.ready, /Output unavailable/);
  task.cancel();
  assert.equal(task.context.state, 'closed');
});

test('context interruption retires audio, reports it once, and never resumes on foreground return', async t => {
  let interruptions = 0;
  const audio = lifecycleFor(t, { onInterrupted: () => { interruptions += 1; } });
  const task = audio.begin();
  await task.ready;
  audio.markPlaying(task.context);
  task.finish();
  task.context.change('interrupted');
  assert.equal(interruptions, 1);
  assert.equal(task.context.state, 'closed');
  browserWindow.dispatchEvent(new Event('pageshow'));
  browserDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(interruptions, 1);
  assert.equal(task.context.resumeCalls, 1);
  const next = audio.begin();
  await next.ready;
  assert.notEqual(next.context, task.context);
});

test('audio session interruption is observed without a visibility event', async t => {
  let interruptions = 0;
  const audio = lifecycleFor(t, { onInterrupted: () => { interruptions += 1; } });
  const task = audio.begin();
  await task.ready;
  audio.markPlaying(task.context);
  task.finish();
  session.state = 'interrupted';
  session.dispatchEvent(new Event('statechange'));
  assert.equal(interruptions, 1);
  assert.equal(task.context.state, 'closed');
});

test('healthy background playback stays running and retired events cannot stop its replacement', async t => {
  let interruptions = 0;
  const audio = lifecycleFor(t, { onInterrupted: () => { interruptions += 1; } });
  const old = audio.begin();
  await old.ready;
  audio.markPlaying(old.context);
  old.finish();
  browserDocument.visibilityState = 'hidden';
  browserDocument.dispatchEvent(new Event('visibilitychange'));
  assert.equal(old.context.state, 'running');
  audio.release(old.context);
  const next = audio.begin();
  await next.ready;
  audio.markPlaying(next.context);
  next.finish();
  old.context.change('closed');
  audio.release(old.context);
  assert.equal(next.context.state, 'running');
  assert.equal(interruptions, 0);
});

test('foreground check catches a missed context interruption event', async t => {
  let interruptions = 0;
  const audio = lifecycleFor(t, { onInterrupted: () => { interruptions += 1; } });
  const task = audio.begin();
  await task.ready;
  audio.markPlaying(task.context);
  task.finish();
  task.context.state = 'suspended';
  browserWindow.dispatchEvent(new Event('pageshow'));
  assert.equal(interruptions, 1);
});

test('Recover audio activates a replacement immediately even when closing the previous context stalls', async t => {
  const audio = lifecycleFor(t);
  const old = audio.begin();
  await old.ready;
  const preparation = deferred();
  const cancelled = assert.rejects(old.wait(preparation.promise), { name: 'AbortError' });
  AudioContext.close = () => new Promise(() => {});
  const recovery = audio.begin({ kind: 'recover', fresh: true });
  assert.notEqual(recovery.context, old.context);
  assert.equal(recovery.context.resumeCalls, 1);
  const recovering = audio.recover(recovery);
  await flush();
  recovery.context.currentTime = .1;
  t.mock.timers.tick(250);
  await recovering;
  await cancelled;
  recovery.finish();
  old.cancel();
  const next = audio.begin();
  assert.equal(next.context, recovery.context);
  await next.ready;
});

test('Recover audio accepts a running clock when Safari leaves its resume promise pending', async t => {
  const audio = lifecycleFor(t);
  AudioContext.resume = context => { context.state = 'running'; return new Promise(() => {}); };
  const task = audio.begin({ kind: 'recover', fresh: true });
  const recovering = audio.recover(task);
  t.mock.timers.tick(1200);
  await flush();
  task.context.currentTime = .1;
  t.mock.timers.tick(250);
  await recovering;
  assert.equal(task.finish(), true);
});

test('Recover audio cycles suspend and resume if the first clock check fails', async t => {
  const audio = lifecycleFor(t);
  const task = audio.begin({ kind: 'recover', fresh: true });
  const recovering = audio.recover(task);
  await flush();
  t.mock.timers.tick(250);
  await flush();
  task.context.currentTime = .1;
  t.mock.timers.tick(250);
  await recovering;
  assert.equal(task.context.suspendCalls, 1);
  assert.equal(task.context.resumeCalls, 2);
});

test('Recover audio reports an unresponsive clock after its bounded retry', async t => {
  const audio = lifecycleFor(t);
  const task = audio.begin({ kind: 'recover', fresh: true });
  const failure = assert.rejects(audio.recover(task), /Audio clock did not recover/);
  await flush();
  t.mock.timers.tick(250);
  await flush();
  t.mock.timers.tick(250);
  await failure;
  task.cancel();
  assert.equal(task.context.state, 'closed');
  assert.ok(task.context.nodes.every(node => !node.connected));
});

test('a cancelled recovery releases its clock probe without retiring a new context', async t => {
  const audio = lifecycleFor(t);
  const old = audio.begin({ kind: 'recover', fresh: true });
  const cancelled = assert.rejects(audio.recover(old), { name: 'AbortError' });
  await flush();
  const next = audio.begin();
  await next.ready;
  await cancelled;
  old.cancel();
  assert.equal(next.current(), true);
  assert.equal(next.context.state, 'running');
  assert.ok(old.context.nodes.every(node => !node.connected));
});

test('playback remains available when the Audio Session API is absent', async t => {
  delete navigator.audioSession;
  const audio = lifecycleFor(t);
  const task = audio.begin();
  await task.ready;
  audio.markPlaying(task.context);
  assert.equal(task.finish(), true);
});

test('Recover audio preserves a context-construction failure for visible reporting', async t => {
  const audio = lifecycleFor(t);
  t.mock.method(globalThis, 'AudioContext', function () { throw new Error('Audio device unavailable'); });
  const task = audio.begin({ kind: 'recover', fresh: true });
  await assert.rejects(audio.recover(task), /Audio device unavailable/);
  task.cancel();
  assert.equal(audio.pending(), null);
});

test('an externally closed decode context is replaced before the next Play', async t => {
  const audio = lifecycleFor(t);
  const decodedWith = audio.get();
  await decodedWith.close();
  const task = audio.begin();
  await task.ready;
  assert.notEqual(task.context, decodedWith);
  assert.equal(task.context.state, 'running');
});
