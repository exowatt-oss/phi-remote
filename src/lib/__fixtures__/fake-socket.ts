/** Test double for a WebSocket plus helpers to play the hub side of the protocol. */

import type { SocketLike } from '../connection';

type Frame = Record<string, unknown> & { t: string };

export class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  closedBy: { code?: number; reason?: string } | null = null;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data?: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }

  static reset(): void {
    FakeSocket.all = [];
  }

  static last(): FakeSocket {
    const s = FakeSocket.all[FakeSocket.all.length - 1];
    if (!s) throw new Error('no socket created');
    return s;
  }

  static factory = (url: string): SocketLike => new FakeSocket(url);

  send(data: string): void {
    if (this.closedBy) throw new Error('socket closed');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedBy = { code, reason };
  }

  // ---- hub side ----

  open(): void {
    this.onopen?.();
  }

  receive(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(code: number, reason?: string): void {
    this.onclose?.({ code, reason });
  }

  fail(): void {
    this.onerror?.();
    this.onclose?.({ code: 1006 });
  }

  frames(): Frame[] {
    return this.sent.map((s) => JSON.parse(s) as Frame);
  }

  framesOf(t: string): Frame[] {
    return this.frames().filter((f) => f.t === t);
  }

  lastOf(t: string): Frame {
    const list = this.framesOf(t);
    const f = list[list.length - 1];
    if (!f) throw new Error(`no ${t} frame sent; sent: ${this.frames().map((x) => x.t).join(', ')}`);
    return f;
  }

  /** Replies to the most recent request of type `t`. */
  replyTo(t: string, reply: Frame): void {
    const req = this.lastOf(t);
    this.receive({ ...reply, re: req.id });
  }

  /** open() + answer hello with welcome. */
  accept(hubId: string, name = 'MY-MAC', protocol = 1): void {
    this.open();
    this.receive({ t: 'welcome', host: { name, hubId, hubVersion: '0.1.0', protocol }, deviceId: 'dev-1' });
  }
}

export function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 's1',
    name: 'Fix the build',
    cwd: '/Users/Alex/ExampleCo/phi',
    host: 'MY-MAC',
    pid: 4242,
    kind: 'interactive',
    status: 'idle',
    model: { provider: 'anthropic', id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
    startedAt: 1_000,
    lastActivityAt: 2_000,
    lastText: 'Done.',
    ...overrides,
  };
}
