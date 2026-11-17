import { DeviceError } from './bytes';

/** A raw byte pipe to a flight controller. Web Serial in the product; an in-memory pair in tests and demos. */
export interface ByteTransport {
  readonly label: string;
  /** USB identity where the transport knows it. */
  readonly usb?: { vendorId?: number; productId?: number };
  write(bytes: Uint8Array): Promise<void>;
  /** Subscribe to received bytes. Returns an unsubscribe function. */
  onData(listener: (bytes: Uint8Array) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  /** Change line speed where that means something. */
  setBaud?(baud: number): Promise<void>;
  close(): Promise<void>;
  readonly open: boolean;
}

/** Shared listener plumbing for transports. */
export class TransportBase {
  protected dataListeners = new Set<(bytes: Uint8Array) => void>();
  protected closeListeners = new Set<(reason: string) => void>();
  open = true;
  onData(listener: (bytes: Uint8Array) => void) { this.dataListeners.add(listener); return () => { this.dataListeners.delete(listener); }; }
  onClose(listener: (reason: string) => void) { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }
  protected emit(bytes: Uint8Array) { for (const l of [...this.dataListeners]) l(bytes); }
  protected closed(reason: string) {
    if (!this.open) return;
    this.open = false;
    for (const l of [...this.closeListeners]) l(reason);
  }
}

/** One end of an in-memory pipe. Delivery is asynchronous, like a real port. */
export class LoopbackEnd extends TransportBase implements ByteTransport {
  peer!: LoopbackEnd;
  /** Bytes written by this end, for assertions. */
  sent: Uint8Array[] = [];
  constructor(readonly label: string, readonly usb?: { vendorId?: number; productId?: number }) { super(); }
  async write(bytes: Uint8Array) {
    if (!this.open) throw new DeviceError('disconnected', 'The connection is closed.');
    const copy = Uint8Array.from(bytes);
    this.sent.push(copy);
    queueMicrotask(() => { if (this.peer.open) this.peer.emit(copy); });
  }
  async close() { this.closed('closed'); this.peer.closed('peer closed'); }
  /** Simulate the cable being pulled or the device rebooting. */
  drop(reason = 'device disconnected') { this.closed(reason); this.peer.closed(reason); }
}
export function loopback(label = 'loopback', usb?: { vendorId?: number; productId?: number }): [host: LoopbackEnd, device: LoopbackEnd] {
  const host = new LoopbackEnd(label, usb), device = new LoopbackEnd(`${label}:device`);
  host.peer = device; device.peer = host;
  return [host, device];
}

/** Web Serial. The browser shows its own device chooser; a page cannot open a port without the person choosing it. */
export class WebSerialTransport extends TransportBase implements ByteTransport {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private constructor(private port: SerialPort, readonly label: string, readonly usb: { vendorId?: number; productId?: number }, private baud: number) { super(); }
  static supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }
  /** Must be called from a click or key press. */
  static async request(baud = 115200): Promise<WebSerialTransport> {
    if (!WebSerialTransport.supported()) throw new DeviceError('unsupported', 'This browser cannot open USB serial devices.', 'Use Chrome or Edge on a computer.');
    const port = await navigator.serial.requestPort();
    return WebSerialTransport.from(port, baud);
  }
  static async from(port: SerialPort, baud = 115200) {
    const info = port.getInfo();
    const label = info.usbVendorId ? `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId ?? 0).toString(16).padStart(4, '0')}` : 'Serial port';
    const transport = new WebSerialTransport(port, label, { vendorId: info.usbVendorId, productId: info.usbProductId }, baud);
    await transport.start();
    return transport;
  }
  get serialPort() { return this.port; }
  private async start() {
    await this.port.open({ baudRate: this.baud, bufferSize: 1 << 16 });
    this.open = true;
    this.writer = this.port.writable!.getWriter();
    void this.pump();
    this.port.addEventListener('disconnect', () => this.closed('device disconnected'), { once: true });
  }
  private async pump() {
    try {
      while (this.open && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value?.length) this.emit(value);
          }
        } finally { this.reader.releaseLock(); }
        if (!this.open) break;
      }
    } catch { /* fall through to closed */ }
    this.closed('device disconnected');
  }
  async write(bytes: Uint8Array) {
    if (!this.open || !this.writer) throw new DeviceError('disconnected', 'The connection is closed.');
    await this.writer.write(bytes);
  }
  async setBaud(baud: number) {
    if (baud === this.baud) return;
    await this.stop();
    this.baud = baud;
    await this.start();
  }
  private async stop() {
    this.open = false;
    try { await this.reader?.cancel(); } catch { /* already closed */ }
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    try { await this.port.close(); } catch { /* already closed */ }
  }
  async close() { await this.stop(); for (const l of [...this.closeListeners]) l('closed'); }
}
